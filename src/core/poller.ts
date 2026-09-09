import { AuthError, BudgetExhaustedError, type AlphabotClient } from '../api/client.js';
import { getRaffleWithRequirements, listActiveRaffles } from '../api/raffles.js';
import type { RaffleForList, RaffleWithRequirements } from '../api/types.js';
import type { AppConfig } from '../config.js';
import { log } from '../logger.js';
import type { EntryQueue } from './entry-queue.js';
import type { EntryStore } from './store.js';

/** GETs held back so the next cycle can always afford its list call. */
const BUDGET_RESERVE = 4;

export interface PollerDeps {
  config: AppConfig;
  client: AlphabotClient;
  queue: Pick<EntryQueue, 'submit'>;
  store: Pick<EntryStore, 'isBlocked'>;
}

/** Downtime safety net: catches raffles whose webhook arrived while the bot was down. */
export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private halted = false;
  /** Slugs a GET has already been spent on, so budget is never spent twice. */
  private readonly attempted = new Set<string>();
  /**
   * Requirements fetched earlier, re-submitted on later cycles so the queue
   * always sees the enriched raffle rather than the bare list entry.
   * Pruned to whatever is still active at the end of each scan.
   */
  private readonly enriched = new Map<string, RaffleWithRequirements>();

  constructor(private readonly deps: PollerDeps) {}

  get stopped(): boolean {
    return this.halted;
  }

  async runOnce(): Promise<number> {
    try {
      return await this.scan();
    } catch (error) {
      return this.handleError(error);
    }
  }

  private async scan(): Promise<number> {
    const { client, config, queue } = this.deps;

    const raffles: RaffleForList[] = await listActiveRaffles(client, {
      pageSize: config.poll.pageSize,
    });

    let resolvedThisCycle = 0;
    let unresolved = 0;

    for (const raffle of raffles) {
      let candidate: RaffleWithRequirements = this.enriched.get(raffle.slug) ?? raffle;

      if (candidate === raffle && this.needsResolving(raffle)) {
        if (this.canResolve(resolvedThisCycle)) {
          const full = await this.resolve(raffle.slug);
          if (full) {
            candidate = full;
            this.enriched.set(raffle.slug, full);
          }
          // `attempted` gains the slug only when a request actually went out,
          // so it distinguishes budget spent from budget denied.
          if (this.attempted.has(raffle.slug)) resolvedThisCycle += 1;
          else unresolved += 1;
        } else {
          unresolved += 1;
        }
      }

      queue.submit(candidate, 'poller');
    }

    this.pruneCache(raffles);

    log.info(`Poller found ${raffles.length} unregistered active raffles`, {
      resolved: resolvedThisCycle,
      deferred: unresolved,
      cached: this.enriched.size,
      getBudgetRemaining: client.budgetRemaining,
    });

    return raffles.length;
  }

  /** Drops requirements for raffles that are no longer active. */
  private pruneCache(raffles: RaffleForList[]): void {
    const active = new Set(raffles.map((r) => r.slug));
    for (const slug of this.enriched.keys()) {
      if (!active.has(slug)) this.enriched.delete(slug);
    }
  }

  /**
   * The list endpoint says a raffle is Discord-gated but not which server,
   * so these need a second request before they can be judged.
   */
  private needsResolving(raffle: RaffleForList): boolean {
    const { config, store } = this.deps;
    if (!config.poll.resolveDiscordRequirements) return false;
    if (!config.discord.requireGuildWhitelist) return false;

    const req = raffle.reqString ?? '';
    if (!req.includes('d') && !req.includes('r')) return false;

    if (this.attempted.has(raffle.slug)) return false;
    return !store.isBlocked(raffle.slug);
  }

  private canResolve(resolvedThisCycle: number): boolean {
    return resolvedThisCycle < this.deps.config.poll.maxResolvesPerCycle
      && this.deps.client.budgetRemaining > BUDGET_RESERVE;
  }

  private async resolve(slug: string): Promise<RaffleWithRequirements | undefined> {
    try {
      const full = await getRaffleWithRequirements(this.deps.client, slug);
      // Mark it done either way: a raffle that resolves to nothing useful must
      // not be retried every cycle, or it would burn the budget forever.
      this.attempted.add(slug);
      return full;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (error instanceof BudgetExhaustedError) return undefined;
      log.warn(`Could not resolve requirements for ${slug}`, {
        message: (error as Error).message,
      });
      this.attempted.add(slug);
      return undefined;
    }
  }

  private handleError(error: unknown): number {
    if (error instanceof AuthError) {
      this.halted = true;
      this.stop();
      log.error('Poller halted: Alphabot rejected the API key');
      return 0;
    }
    if (error instanceof BudgetExhaustedError) {
      log.warn('Poller skipped this cycle to protect the hourly GET budget');
      return 0;
    }
    log.warn('Poller cycle failed', { message: (error as Error).message });
    return 0;
  }

  start(): void {
    if (!this.deps.config.poll.enabled || this.timer) return;
    const intervalMs = this.deps.config.poll.intervalSeconds * 1000;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
    this.timer.unref?.();
    log.info(`Poller started, every ${this.deps.config.poll.intervalSeconds}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
