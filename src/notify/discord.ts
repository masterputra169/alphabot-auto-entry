import { log } from '../logger.js';
import type { RaffleEntry, RaffleForList } from '../api/types.js';
import type { RegisterOutcome } from '../api/raffles.js';
import type { SkipReason } from '../core/filter.js';
import { WebhookSender, type SenderOptions } from './sender.js';

const COLOR_SUCCESS = 0x2ecc71;
const COLOR_FAILURE = 0xe67e22;
const COLOR_WIN = 0xf1c40f;
const COLOR_FATAL = 0xe74c3c;

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface Embed {
  title: string;
  url?: string;
  description?: string;
  color: number;
  fields?: EmbedField[];
  timestamp: string;
}

/** Where one notification goes, and whether it should ping. */
interface Target {
  url: string | null;
  mention?: string | null;
}

export interface NotifierOptions {
  webhookUrl: string | null;
  /** Channel dedicated to wins. Wins fall back to `webhookUrl` when unset. */
  winWebhookUrl?: string | null;
  /** Sent as message content beside a win embed, e.g. `@everyone`, so it pings. */
  winMention?: string | null;
  fetchImpl?: typeof fetch;
  /** Retry and pacing behaviour; the defaults suit Discord's real limits. */
  delivery?: SenderOptions;
}

const raffleUrl = (slug: string) => `https://www.alphabot.app/${slug}`;

/** The facts about the raffle itself that every embed carries, when known. */
function raffleFields(raffle: RaffleForList): EmbedField[] {
  const fields: EmbedField[] = [];
  if (raffle.winnerCount !== undefined) {
    fields.push({ name: 'Winners', value: String(raffle.winnerCount), inline: true });
  }
  if (raffle.blockchain) {
    fields.push({ name: 'Chain', value: raffle.blockchain, inline: true });
  }
  return fields;
}

export class DiscordNotifier {
  private readonly webhookUrl: string | null;
  private readonly winWebhookUrl: string | null;
  private readonly winMention: string | null;
  private readonly sender: WebhookSender;

  constructor(options: NotifierOptions) {
    this.webhookUrl = options.webhookUrl;
    this.winWebhookUrl = options.winWebhookUrl ?? null;
    this.winMention = options.winMention ?? null;
    this.sender = new WebhookSender({
      fetchImpl: options.fetchImpl,
      ...options.delivery,
    });
  }

  /** Resolves with whether the alert reached Discord. */
  async entered(raffle: RaffleForList, outcome: RegisterOutcome): Promise<boolean> {
    const fields: EmbedField[] = [];
    if (outcome.entries !== null) {
      fields.push({ name: 'Entries', value: String(outcome.entries), inline: true });
    }
    fields.push(...raffleFields(raffle));

    return this.send({
      title: `Entered: ${raffle.name}`,
      url: raffleUrl(raffle.slug),
      color: COLOR_SUCCESS,
      fields,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Alphabot declined the entry for a reason the owner can act on. Common and
   * expected, so it stays in the log rather than flooding the channel.
   */
  async rejected(raffle: RaffleForList, message: string): Promise<void> {
    log.info(`Entry rejected for ${raffle.slug}`, { name: raffle.name, message });
  }

  /** Something went wrong that the owner could not have predicted. */
  async failed(raffle: RaffleForList, message: string): Promise<boolean> {
    return this.send({
      title: `Entry failed: ${raffle.name}`,
      url: raffleUrl(raffle.slug),
      description: message.slice(0, 1000),
      color: COLOR_FAILURE,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * The one notification worth interrupting someone for, so it goes to its own
   * channel when one is configured and may carry a mention.
   */
  async won(raffle: RaffleForList, entry: RaffleEntry | undefined): Promise<boolean> {
    const fields: EmbedField[] = [];
    if (entry?.mintAddress) {
      fields.push({ name: 'Mint address', value: entry.mintAddress, inline: false });
    }
    if (entry?.entries !== undefined) {
      fields.push({ name: 'Your entries', value: String(entry.entries), inline: true });
    }
    fields.push(...raffleFields(raffle));

    return this.send({
      title: `🏆 Won: ${raffle.name}`,
      url: raffleUrl(raffle.slug),
      color: COLOR_WIN,
      fields,
      timestamp: new Date().toISOString(),
    }, { url: this.winWebhookUrl ?? this.webhookUrl, mention: this.winMention });
  }

  async fatal(message: string): Promise<boolean> {
    return this.send({
      title: 'Alphabot Auto Entry stopped',
      description: message.slice(0, 1000),
      color: COLOR_FATAL,
      timestamp: new Date().toISOString(),
    });
  }

  /** Waits for alerts still queued, so a shutdown does not discard them. */
  async flush(): Promise<void> {
    await this.sender.drain();
  }

  /** Skips are the common case; logging them keeps the channel readable. */
  async skipped(raffle: RaffleForList, reason: SkipReason, detail?: string): Promise<void> {
    log.info(`Skipped ${raffle.slug}`, {
      reason,
      name: raffle.name,
      ...(detail ? { missing: detail } : {}),
    });
  }

  /**
   * True once Discord has the message. A channel that is not configured counts
   * as delivered: there is nothing outstanding, so nothing to retry.
   */
  private async send(embed: Embed, target?: Target): Promise<boolean> {
    const url = target?.url ?? this.webhookUrl;
    if (!url) return true;

    const mention = target?.mention;
    return this.sender.post(url, {
      ...(mention ? { content: mention } : {}),
      embeds: [embed],
    });
  }
}
