import type { WebhookBody } from '../api/types.js';
import type { EntryQueue } from '../core/entry-queue.js';
import { log } from '../logger.js';
import type { WinAnnouncer } from '../notify/win-announcer.js';

export interface HandlerDeps {
  queue: Pick<EntryQueue, 'submit'>;
  wins: Pick<WinAnnouncer, 'announce'>;
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
      if (!raffle) {
        // The one event worth interrupting someone for must never disappear
        // without a trace, however malformed it arrives.
        log.warn('raffle:won arrived without a raffle payload');
        return;
      }
      await deps.wins.announce(raffle, body.data?.entry);
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
