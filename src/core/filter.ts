import type { AppConfig } from '../config.js';
import type { RaffleWithRequirements } from '../api/types.js';

export type SkipReason =
  | 'not_active'
  | 'ended'
  | 'already_entered'
  | 'captcha_required'
  | 'password_required'
  | 'token_gated'
  | 'eth_balance_required'
  | 'nft_holding_required'
  | 'discord_guild_not_joined'
  | 'discord_requirements_unknown'
  | 'blockchain_excluded'
  | 'keyword_excluded'
  | 'too_few_winners';

export interface FilterContext {
  config: AppConfig;
  knownGuildIds: ReadonlySet<string>;
  isEntered: (slug: string) => boolean;
  hasPassword: boolean;
  /** Webhook payloads carry full requirements; poller payloads do not. */
  fromWebhook: boolean;
  now?: number;
}

export type FilterResult = { eligible: true } | { eligible: false; reason: SkipReason };

const skip = (reason: SkipReason): FilterResult => ({ eligible: false, reason });
const PASS: FilterResult = { eligible: true };

/**
 * Decides whether the owner can plausibly satisfy a raffle's requirements.
 *
 * Twitter follow / like / retweet rules are deliberately not checked here:
 * entering is cheap, and Alphabot's own validation reports authoritatively
 * whether they were met.
 */
export function evaluate(raffle: RaffleWithRequirements, ctx: FilterContext): FilterResult {
  const { entry, discord } = ctx.config;
  const now = ctx.now ?? Date.now();

  if (raffle.status !== 'active') return skip('not_active');
  if (typeof raffle.endDate === 'number' && raffle.endDate <= now) return skip('ended');
  if (ctx.isEntered(raffle.slug)) return skip('already_entered');

  if (entry.skipCaptcha && raffle.connectCaptcha === true) return skip('captcha_required');
  if (raffle.connectPassword === true && !ctx.hasPassword) return skip('password_required');

  if (entry.skipTokenGated) {
    if ((raffle.requiredTokens?.length ?? 0) > 0) return skip('token_gated');
    if ((raffle.requiredEth ?? 0) > 0) return skip('eth_balance_required');
  }

  const reqString = raffle.reqString ?? '';
  if (entry.skipNftHolding && reqString.includes('n')) return skip('nft_holding_required');

  if (discord.requireGuildWhitelist) {
    const servers = raffle.discordServerRoles ?? [];
    if (servers.length > 0) {
      const required = servers.filter((s) => s.exclude !== true);
      const allKnown = required.every((s) => ctx.knownGuildIds.has(s.id));
      if (!allKnown) return skip('discord_guild_not_joined');
    } else if (!ctx.fromWebhook && (reqString.includes('d') || reqString.includes('r'))) {
      // The list endpoint does not expose which guild is required, and resolving it
      // would spend the scarce GET budget. Webhooks are the path for these raffles.
      return skip('discord_requirements_unknown');
    }
  }

  if (entry.allowedBlockchains.length > 0) {
    const chain = raffle.blockchain?.toLowerCase() ?? '';
    const allowed = entry.allowedBlockchains.map((c) => c.toLowerCase());
    if (!allowed.includes(chain)) return skip('blockchain_excluded');
  }

  if (entry.excludeKeywords.length > 0) {
    const name = raffle.name.toLowerCase();
    if (entry.excludeKeywords.some((k) => name.includes(k.toLowerCase()))) {
      return skip('keyword_excluded');
    }
  }

  if ((raffle.winnerCount ?? 0) < entry.minWinnerCount) return skip('too_few_winners');

  return PASS;
}
