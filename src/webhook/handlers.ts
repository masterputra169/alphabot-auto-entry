import type { WebhookBody } from '../api/types.js';
import type { EntryQueue } from '../core/entry-queue.js';
import type { EntryStore } from '../core/store.js';
import { log } from '../logger.js';
import type { DiscordNotifier } from '../notify/discord.js';

export interface HandlerDeps {
  queue: Pick<EntryQueue, 'submit'>;
  notifier: DiscordNotifier;
  store: Pick<EntryStore, 'markWon'>;
}

export async function handleEvent(body: WebhookBody, deps: HandlerDeps): Promise<void> {
  const raffle = body.data?.raffle;

  switch (body.event) {
    case 'raffle:active': {
      if (!raffle) {
        log.warn('raffle:active arrived without a raffle payload');
        return;
      }
      log.info(`Webhook raffle:active ${raffle.slug}`, { name: raffle.name });
      deps.queue.submit(raffle, 'webhook');
      return;
    }

    case 'raffle:won': {
      if (!raffle) return;
      // Alphabot retries deliveries, so only the first one is news. Recording
      // the win before alerting is what keeps the win channel from pinging
      // twice for the same raffle.
      const isNewWin = await deps.store.markWon(raffle.slug, raffle.name);
      if (!isNewWin) {
        log.debug(`Ignoring a repeated win for ${raffle.slug}`);
        return;
      }
      log.info(`Won raffle ${raffle.slug}`, { name: raffle.name });
      await deps.notifier.won(raffle, body.data?.entry);
      return;
    }

    case 'webhook:test': {
      log.info('Received webhook:test from Alphabot');
      return;
    }

    default:
      log.debug(`Ignoring event ${body.event}`);
  }
}
