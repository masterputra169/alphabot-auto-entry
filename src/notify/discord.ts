import { log } from '../logger.js';
import type { RaffleEntry, RaffleForList } from '../api/types.js';
import type { RegisterOutcome } from '../api/raffles.js';
import type { SkipReason } from '../core/filter.js';

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

const raffleUrl = (slug: string) => `https://www.alphabot.app/${slug}`;

export class DiscordNotifier {
  constructor(
    private readonly webhookUrl: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async entered(raffle: RaffleForList, outcome: RegisterOutcome): Promise<void> {
    const fields: EmbedField[] = [];
    if (outcome.entries !== null) {
      fields.push({ name: 'Entries', value: String(outcome.entries), inline: true });
    }
    if (raffle.winnerCount !== undefined) {
      fields.push({ name: 'Winners', value: String(raffle.winnerCount), inline: true });
    }
    if (raffle.blockchain) {
      fields.push({ name: 'Chain', value: raffle.blockchain, inline: true });
    }

    await this.send({
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
  async failed(raffle: RaffleForList, message: string): Promise<void> {
    await this.send({
      title: `Entry failed: ${raffle.name}`,
      url: raffleUrl(raffle.slug),
      description: message.slice(0, 1000),
      color: COLOR_FAILURE,
      timestamp: new Date().toISOString(),
    });
  }

  async won(raffle: RaffleForList, entry: RaffleEntry | undefined): Promise<void> {
    const fields: EmbedField[] = [];
    if (entry?.mintAddress) {
      fields.push({ name: 'Mint address', value: entry.mintAddress, inline: false });
    }
    await this.send({
      title: `You won: ${raffle.name}`,
      url: raffleUrl(raffle.slug),
      color: COLOR_WIN,
      fields,
      timestamp: new Date().toISOString(),
    });
  }

  async fatal(message: string): Promise<void> {
    await this.send({
      title: 'Alphabot Auto Entry stopped',
      description: message.slice(0, 1000),
      color: COLOR_FATAL,
      timestamp: new Date().toISOString(),
    });
  }

  /** Skips are the common case; logging them keeps the channel readable. */
  async skipped(raffle: RaffleForList, reason: SkipReason, detail?: string): Promise<void> {
    log.info(`Skipped ${raffle.slug}`, {
      reason,
      name: raffle.name,
      ...(detail ? { missing: detail } : {}),
    });
  }

  private async send(embed: Embed): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      const response = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (!response.ok) {
        log.warn('Discord notification rejected', { status: response.status });
      }
    } catch (error) {
      log.warn('Discord notification failed', { message: (error as Error).message });
    }
  }
}
