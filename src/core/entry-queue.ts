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
  store: Pick<EntryStore, 'isBlocked' | 'record'>;
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
    this.running ??= this.run().finally(() => {
      this.running = null;
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
      await notifier.entered(raffle, {
        success: true, entries: null, reason: null, resultMd: 'dry run', blockers: [],
      });
      return;
    }

    try {
      const outcome = await register(client, input);

      await store.record({
        slug: raffle.slug,
        name: raffle.name,
        at: Date.now(),
        success: outcome.success,
        entries: outcome.entries,
        reason: outcome.reason,
        blockers: outcome.blockers,
        retryAfter: outcome.success ? null : this.retryAt(outcome.reason),
      });

      if (outcome.success) {
        log.info(`Entered ${raffle.slug}`, { entries: outcome.entries, source });
        await notifier.entered(raffle, outcome);
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
        await notifier.fatal(error.message);
        this.deps.onAuthError?.(error);
        return;
      }

      const message = (error as Error).message;
      // Alphabot declining the entry means nothing was registered, and the
      // owner may well complete the missing task later, so allow a retry.
      // An unknown outcome (5xx, network, retries exhausted) stays permanent.
      const declined = error instanceof ApiError && error.declined;

      await store.record({
        slug: raffle.slug,
        name: raffle.name,
        at: Date.now(),
        success: false,
        entries: null,
        reason: message,
        retryAfter: declined ? this.retryAt(null) : null,
      });

      if (declined) {
        await notifier.rejected(raffle, message);
      } else {
        log.error(`Entry failed for ${raffle.slug}`, { message });
        await notifier.failed(raffle, message);
      }
    }
  }

  /**
   * When to try again, or null for never. A raffle that has ended can never
   * be entered, so rescheduling it would burn register calls for nothing.
   * Anything else the owner may still be able to satisfy.
   */
  private retryAt(reason: string | null): number | null {
    if (reason !== null && FINAL_REASONS.has(reason)) return null;
    return Date.now() + this.deps.config.entry.retryHours * 3_600_000;
  }
}
