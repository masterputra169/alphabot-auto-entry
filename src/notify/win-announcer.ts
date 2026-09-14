import type { AlphabotClient } from '../api/client.js';
import { listWonRaffles } from '../api/raffles.js';
import type { RaffleEntry, RaffleForList } from '../api/types.js';
import type { EntryRecord, EntryStore } from '../core/store.js';
import { log } from '../logger.js';
import type { DiscordNotifier } from './discord.js';

export interface WinAnnouncerDeps {
  store: Pick<EntryStore, 'markWon' | 'settleWin' | 'pendingWins' | 'get' | 'seedWon'>;
  notifier: Pick<DiscordNotifier, 'won'>;
  client: AlphabotClient;
  /** How often the backlog of unannounced wins is retried. */
  intervalSeconds: number;
  /** How often to ask Alphabot which raffles were won. 0 disables it. */
  reconcileHours: number;
  pageSize: number;
}

/**
 * Enough of a raffle to build an embed from a record alone. A retried alert
 * knows the name and the slug but not the chain or the winner count, and a
 * plainer alert is worth far more than a missing one.
 */
function raffleFrom(record: EntryRecord): RaffleForList {
  return {
    _id: record.slug, slug: record.slug, name: record.name, status: 'ended',
  };
}

/**
 * Owns the one notification worth interrupting someone for.
 *
 * Alphabot redelivers `raffle:won`, but relying on that was how alerts went
 * missing: a redelivery that arrived while an attempt was still retrying was
 * dismissed as a duplicate, and if that attempt then failed the last chance
 * went with it. So the win is recorded permanently the moment it is known,
 * separately from whether Discord has heard about it, and anything still
 * unannounced is retried here rather than waiting on Alphabot to try again.
 */
export class WinAnnouncer {
  private timer: NodeJS.Timeout | null = null;
  private reconciler: NodeJS.Timeout | null = null;

  constructor(private readonly deps: WinAnnouncerDeps) {}

  /** The webhook path: Alphabot has just said a raffle was won. */
  async announce(raffle: RaffleForList, entry: RaffleEntry | undefined): Promise<void> {
    if (!await this.deps.store.markWon(raffle.slug, raffle.name)) {
      log.debug(`Ignoring a repeated win for ${raffle.slug}`);
      return;
    }

    log.info(`Won raffle ${raffle.slug}`, { name: raffle.name });
    await this.deliver(raffle, entry);
  }

  /** The safety net: every win Discord has still not been told about. */
  async retryPending(): Promise<number> {
    let delivered = 0;

    for (const record of this.deps.store.pendingWins()) {
      // Skipped when the webhook path is already attempting this one.
      if (!await this.deps.store.markWon(record.slug, record.name)) continue;

      log.info(`Retrying the win alert for ${record.slug}`, { name: record.name });
      if (await this.deliver(raffleFrom(record), undefined)) delivered += 1;
    }

    return delivered;
  }

  /**
   * Asks Alphabot what this account has won, and announces anything the
   * webhooks never delivered.
   *
   * The poller exists because `raffle:active` deliveries are lost while the
   * container is down; wins had no such safety net, and a win nobody was told
   * about is indistinguishable from one whose alert failed. Costs one GET.
   */
  async reconcile(): Promise<number> {
    let won: RaffleForList[];
    try {
      won = await listWonRaffles(this.deps.client, { pageSize: this.deps.pageSize });
    } catch (error) {
      log.warn('Could not reconcile wins with Alphabot', { message: (error as Error).message });
      return 0;
    }

    let announced = 0;
    for (const raffle of won) {
      const record = this.deps.store.get(raffle.slug);
      if (record?.won) continue;

      // A win on a raffle this bot never entered belongs to the owner, not to
      // the bot, and on a first run there could be years of them.
      if (!record?.success) {
        log.info(`Recording a win this bot did not enter: ${raffle.slug}`, { name: raffle.name });
        await this.deps.store.seedWon(raffle.slug, raffle.name);
        continue;
      }

      log.warn(`Alphabot reports a win nobody announced: ${raffle.slug}`, { name: raffle.name });
      if (!await this.deps.store.markWon(raffle.slug, raffle.name)) continue;
      if (await this.deliver(raffle, undefined)) announced += 1;
    }

    return announced;
  }

  private async deliver(
    raffle: RaffleForList,
    entry: RaffleEntry | undefined,
  ): Promise<boolean> {
    const delivered = await this.deps.notifier.won(raffle, entry);
    await this.deps.store.settleWin(raffle.slug, delivered);

    if (!delivered) {
      log.error(`Win alert for ${raffle.slug} did not reach Discord; it stays queued for retry`);
    }
    return delivered;
  }

  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.retryPending().catch((error: Error) => {
          log.warn('Win backlog retry failed', { message: error.message });
        });
      }, this.deps.intervalSeconds * 1000);
      this.timer.unref?.();
    }

    if (!this.reconciler && this.deps.reconcileHours > 0) {
      this.reconciler = setInterval(() => {
        void this.reconcile();
      }, this.deps.reconcileHours * 3_600_000);
      this.reconciler.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.reconciler) clearInterval(this.reconciler);
    this.reconciler = null;
  }
}
