import { ApiError, AuthError, type AlphabotClient } from '../api/client.js';
import { register, type RegisterInput } from '../api/raffles.js';
import type { RaffleWithRequirements } from '../api/types.js';
import type { AppConfig } from '../config.js';
import { log } from '../logger.js';
import type { DiscordNotifier } from '../notify/discord.js';
import { evaluate, type SkipReason } from './filter.js';
import type { EntryStore } from './store.js';

export type EntrySource = 'webhook' | 'poller';

export interface EntryQueueDeps {
  config: AppConfig;
  client: AlphabotClient;
  store: Pick<EntryStore, 'isBlocked' | 'record' | 'get'>;
  notifier: DiscordNotifier;
  guilds: { getGuildIds: () => Promise<ReadonlySet<string>> };
  sleep?: (ms: number) => Promise<void>;
  onAuthError?: (error: Error) => void;
}

interface QueueItem {
  raffle: RaffleWithRequirements;
  source: EntrySource;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Hands an alert to the notifier without waiting for Discord.
 *
 * The notifier paces its own posts to stay inside Discord's channel limit, and
 * a raffle that closes first-come-first-served must not wait on that. Delivery
 * is the notifier's promise to keep; it retries, and a shutdown flushes it.
 *
 * What it must not do is fail quietly: an alert the notifier gave up on is
 * named here, because the generic message from the sender cannot say which
 * raffle went unannounced, and that is the whole complaint being fixed.
 */
function announce(label: string, sent: Promise<boolean>): void {
  void sent.then(
    (delivered) => {
      if (!delivered) log.error(`Discord never received the alert for ${label}`);
    },
    (error: Error) => log.error(`Could not hand the alert for ${label} to the notifier`, {
      message: error.message,
    }),
  );
}

/** Rejection reasons that will never become satisfiable. Observed in production. */
const FINAL_REASONS = new Set(['opportunity_ended', 'cannot_win_twice']);

/**
 * Single consumer for both producers (webhook and poller). Owns dedupe and
 * pacing so neither producer needs to know about the other.
 */
export class EntryQueue {
  private readonly pending: QueueItem[] = [];
  /**
   * Guards against processing one slug twice *concurrently* — nothing more.
   * Protection against entering a raffle twice comes from the store, which is
   * durable. Keeping slugs here permanently would mean a raffle judged before
   * the Discord guild list arrived, or before the poller resolved its
   * requirements, could never be reconsidered.
   */
  private readonly inFlight = new Set<string>();
  /** Last skip reason per slug, so a repeated verdict is not re-reported. */
  private readonly lastSkip = new Map<string, SkipReason>();
  private running: Promise<void> | null = null;
  private authFailed = false;

  constructor(private readonly deps: EntryQueueDeps) {}

  get depth(): number {
    return this.pending.length;
  }

  submit(raffle: RaffleWithRequirements, source: EntrySource): void {
    if (this.inFlight.has(raffle.slug)) return;
    this.inFlight.add(raffle.slug);
    this.pending.push({ raffle, source });
    this.wake();
  }

  private wake(): void {
    this.running ??= this.run().finally(() => {
      this.running = null;
      // A submit landing between the loop draining and this callback would
      // find `running` still set and start nothing, leaving the item queued
      // with its slug held in `inFlight` — so it could not even be offered
      // again until some unrelated submit happened along.
      if (this.pending.length > 0) this.wake();
    });
  }

  /** Resolves once everything currently queued has been processed. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async run(): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    let first = true;

    while (this.pending.length > 0) {
      const item = this.pending.shift();
      if (!item) break;

      if (!first) await sleep(this.deps.config.entry.delayMs);
      first = false;

      await this.process(item);
    }
  }

  private async process(item: QueueItem): Promise<void> {
    try {
      await this.decideAndEnter(item);
    } finally {
      this.inFlight.delete(item.raffle.slug);
    }
  }

  private async decideAndEnter({ raffle, source }: QueueItem): Promise<void> {
    const { config, store, notifier, guilds, client } = this.deps;

    if (this.authFailed) return;

    const knownGuildIds = await guilds.getGuildIds();
    const verdict = evaluate(raffle, {
      config,
      knownGuildIds,
      isEntered: (slug) => store.isBlocked(slug),
      hasPassword: config.env.rafflePassword !== null,
      fromWebhook: source === 'webhook',
    });

    if (!verdict.eligible) {
      // The same raffle is re-judged every poll cycle now, so only report a
      // verdict that actually changed.
      if (this.lastSkip.get(raffle.slug) !== verdict.reason) {
        this.lastSkip.set(raffle.slug, verdict.reason);
        await notifier.skipped(raffle, verdict.reason, verdict.detail);
      }
      return;
    }

    this.lastSkip.delete(raffle.slug);

    const input: RegisterInput = { slug: raffle.slug };
    const { mintAddress, discordId, twitterId, telegramId } = config.submission;
    if (mintAddress) input.mintAddress = mintAddress;
    if (discordId) input.discordId = discordId;
    if (twitterId) input.twitterId = twitterId;
    if (telegramId) input.telegramId = telegramId;

    if (config.entry.dryRun) {
      log.info(`DRY RUN would enter ${raffle.slug}`, { name: raffle.name, source });
      announce(raffle.slug, notifier.entered(raffle, {
        success: true, entries: null, reason: null, resultMd: 'dry run', blockers: [],
      }));
      return;
    }

    try {
      const outcome = await register(client, input);

      const attempts = outcome.success ? 1 : this.declineCount(raffle.slug, outcome.reason);
      await store.record({
        slug: raffle.slug,
        name: raffle.name,
        at: Date.now(),
        success: outcome.success,
        entries: outcome.entries,
        reason: outcome.reason,
        blockers: outcome.blockers,
        attempts,
        projectId: raffle.projectId,
        retryAfter: outcome.success ? null : this.retryAt(outcome.reason, attempts),
      });

      if (outcome.success) {
        log.info(`Entered ${raffle.slug}`, { entries: outcome.entries, source });
        announce(raffle.slug, notifier.entered(raffle, outcome));
      } else {
        await notifier.rejected(
          raffle,
          outcome.reason ?? outcome.resultMd ?? 'Entry was rejected',
        );
      }
    } catch (error) {
      if (error instanceof AuthError) {
        this.authFailed = true;
        log.error('Alphabot authentication failed; no further entries will be attempted');
        // Stop the poller before telling Discord: a rate-limited channel must
        // not decide how long the bot keeps calling an API that rejects it.
        this.deps.onAuthError?.(error);
        announce('the authentication failure', notifier.fatal(error.message));
        return;
      }

      const message = (error as Error).message;
      // Alphabot declining the entry means nothing was registered, and the
      // owner may well complete the missing task later, so allow a retry.
      // An unknown outcome (5xx, network, retries exhausted) stays permanent.
      const declined = error instanceof ApiError && error.declined;

      const attempts = this.declineCount(raffle.slug, message);
      await store.record({
        slug: raffle.slug,
        name: raffle.name,
        at: Date.now(),
        success: false,
        entries: null,
        reason: message,
        attempts,
        projectId: raffle.projectId,
        retryAfter: declined ? this.retryAt(message, attempts) : null,
      });

      if (declined) {
        await notifier.rejected(raffle, message);
      } else {
        log.error(`Entry failed for ${raffle.slug}`, { message });
        announce(raffle.slug, notifier.failed(raffle, message));
      }
    }
  }

  /**
   * How many times in a row this raffle has been declined for this same
   * reason. A different reason means something moved, so the count starts
   * over rather than punishing a raffle for an unrelated earlier failure.
   */
  private declineCount(slug: string, reason: string | null): number {
    const previous = this.deps.store.get(slug);
    if (!previous || previous.success) return 1;
    return previous.reason === reason ? (previous.attempts ?? 1) + 1 : 1;
  }

  /**
   * When to try again, or null for never. A raffle that has ended can never
   * be entered, so rescheduling it would burn register calls for nothing.
   * Anything else the owner may still be able to satisfy — but the same
   * refusal arriving over and over means nobody is going to, so each repeat
   * doubles the wait up to the configured ceiling.
   */
  private retryAt(reason: string | null, attempts: number): number | null {
    if (reason !== null && FINAL_REASONS.has(reason)) return null;

    const { retryHours, maxRetryHours } = this.deps.config.entry;
    const hours = Math.min(retryHours * 2 ** (attempts - 1), maxRetryHours);
    return Date.now() + hours * 3_600_000;
  }
}
