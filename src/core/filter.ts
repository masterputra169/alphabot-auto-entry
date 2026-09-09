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

export type FilterResult =
  | { eligible: true }
  | { eligible: false; reason: SkipReason; detail?: string };

const skip = (reason: SkipReason): FilterResult => ({ eligible: false, reason });
const PASS: FilterResult = { eligible: true };

/** Human-readable server list, so a rejection says which Discord to join. */
function describeServers(servers: { id: string; label?: string }[]): string {
  return servers.map((s) => (s.label ? `${s.label} (${s.id})` : s.id)).join(', ');
}

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
      const missing = required.filter((s) => !ctx.knownGuildIds.has(s.id));

      // Alphabot lists gating servers and bonus-entry servers in the same
      // array, with no flag telling them apart. Requiring all of them rejects
      // raffles the owner actually qualifies for, so `any` is the default:
      // membership in at least one listed server is enough to try.
      const satisfied = required.length === 0
        || (discord.guildMatchMode === 'all'
          ? missing.length === 0
          : missing.length < required.length);

      if (!satisfied) {
        return {
          eligible: false,
          reason: 'discord_guild_not_joined',
          detail: describeServers(missing),
        };
      }
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
