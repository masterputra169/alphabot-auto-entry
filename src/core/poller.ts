import { AuthError, BudgetExhaustedError, type AlphabotClient } from '../api/client.js';
import { listActiveRaffles } from '../api/raffles.js';
import type { AppConfig } from '../config.js';
import { log } from '../logger.js';
import type { EntryQueue } from './entry-queue.js';

export interface PollerDeps {
  config: AppConfig;
  client: AlphabotClient;
  queue: Pick<EntryQueue, 'submit'>;
}

/** Downtime safety net: catches raffles whose webhook arrived while the bot was down. */
export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private halted = false;

  constructor(private readonly deps: PollerDeps) {}

  get stopped(): boolean {
    return this.halted;
  }

  async runOnce(): Promise<number> {
    const { client, config, queue } = this.deps;

    try {
      const raffles = await listActiveRaffles(client, { pageSize: config.poll.pageSize });
      for (const raffle of raffles) queue.submit(raffle, 'poller');
      log.info(`Poller found ${raffles.length} unregistered active raffles`, {
        getBudgetRemaining: client.budgetRemaining,
      });
      return raffles.length;
    } catch (error) {
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
