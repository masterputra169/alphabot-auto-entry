import type { RaffleEntry, RaffleForList } from '../api/types.js';
import type { EntryRecord, EntryStore } from '../core/store.js';
import { log } from '../logger.js';
import type { DiscordNotifier } from './discord.js';

export interface WinAnnouncerDeps {
  store: Pick<EntryStore, 'markWon' | 'settleWin' | 'pendingWins'>;
  notifier: Pick<DiscordNotifier, 'won'>;
  /** How often the backlog of unannounced wins is retried. */
  intervalSeconds: number;
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
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.retryPending().catch((error: Error) => {
        log.warn('Win backlog retry failed', { message: error.message });
      });
    }, this.deps.intervalSeconds * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
