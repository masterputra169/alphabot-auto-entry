import { describe, expect, it } from 'vitest';
import { evaluate, type FilterContext, type FilterResult } from '../../src/core/filter.js';
import type { AppConfig } from '../../src/config.js';
import type { RaffleWithRequirements } from '../../src/api/types.js';

const NOW = 1_700_000_000_000;

const config = (
  over: Partial<AppConfig['entry']> = {},
  discordOver: Partial<AppConfig['discord']> = {},
): AppConfig => ({
  poll: {
    enabled: true, intervalSeconds: 600, pageSize: 50,
    resolveDiscordRequirements: true, maxResolvesPerCycle: 10,
  },
  entry: {
    delayMs: 700, dryRun: false, skipCaptcha: true, skipNftHolding: true,
    skipTokenGated: true, allowedBlockchains: [], excludeKeywords: [], minWinnerCount: 0,
    ...over,
  },
  discord: {
    requireGuildWhitelist: true, guildMatchMode: 'any',
    guildIds: [], refreshHours: 6, ...discordOver,
  },
  submission: { mintAddress: null, discordId: null, twitterId: null, telegramId: null },
  env: {} as AppConfig['env'],
});

const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({
  config: config(),
  knownGuildIds: new Set(['guild-a']),
  isEntered: () => false,
  hasPassword: false,
  fromWebhook: true,
  now: NOW,
  ...over,
});

const raffle = (over: Partial<RaffleWithRequirements> = {}): RaffleWithRequirements => ({
  _id: '1',
  slug: 'test-raffle',
  name: 'Test Raffle',
  status: 'active',
  endDate: NOW + 60_000,
  winnerCount: 10,
  ...over,
});

const reasonOf = (r: FilterResult) => (r.eligible ? null : r.reason);

describe('evaluate', () => {
  it('accepts a plain active raffle with no requirements', () => {
    expect(evaluate(raffle(), ctx())).toEqual({ eligible: true });
  });

  it('accepts a raffle with no endDate at all', () => {
    expect(evaluate(raffle({ endDate: undefined }), ctx()).eligible).toBe(true);
  });

  it('skips a raffle that is not active', () => {
    expect(reasonOf(evaluate(raffle({ status: 'ended' }), ctx()))).toBe('not_active');
  });

  it('skips a raffle whose endDate has passed', () => {
    expect(reasonOf(evaluate(raffle({ endDate: NOW - 1 }), ctx()))).toBe('ended');
  });

  it('skips a raffle already in the store', () => {
    expect(reasonOf(evaluate(raffle(), ctx({ isEntered: () => true })))).toBe('already_entered');
  });

  it('skips captcha gated raffles', () => {
    expect(reasonOf(evaluate(raffle({ connectCaptcha: true }), ctx()))).toBe('captcha_required');
  });

  it('enters a captcha raffle when skipCaptcha is off', () => {
    const c = ctx({ config: config({ skipCaptcha: false }) });
    expect(evaluate(raffle({ connectCaptcha: true }), c).eligible).toBe(true);
  });

  it('skips password gated raffles when no password is configured', () => {
    expect(reasonOf(evaluate(raffle({ connectPassword: true }), ctx()))).toBe('password_required');
  });

  it('enters a password gated raffle when a password is configured', () => {
    expect(evaluate(raffle({ connectPassword: true }), ctx({ hasPassword: true })).eligible)
      .toBe(true);
  });

  it('skips token gated raffles', () => {
    expect(reasonOf(evaluate(raffle({ requiredTokens: [{ any: 'token' }] }), ctx())))
      .toBe('token_gated');
  });

  it('skips raffles requiring an eth balance', () => {
    expect(reasonOf(evaluate(raffle({ requiredEth: 0.5 }), ctx()))).toBe('eth_balance_required');
  });

  it('enters token gated raffles when skipTokenGated is off', () => {
    const c = ctx({ config: config({ skipTokenGated: false }) });
    expect(evaluate(raffle({ requiredEth: 5, requiredTokens: [{}] }), c).eligible).toBe(true);
  });

  it('skips nft holding raffles based on reqString', () => {
    expect(reasonOf(evaluate(raffle({ reqString: 'nd' }), ctx()))).toBe('nft_holding_required');
  });

  it('enters nft raffles when skipNftHolding is off', () => {
    const c = ctx({ config: config({ skipNftHolding: false }) });
    expect(evaluate(raffle({ reqString: 'n' }), c).eligible).toBe(true);
  });

  it('enters a discord gated raffle when the guild is known', () => {
    const r = raffle({ discordServerRoles: [{ id: 'guild-a', label: 'Cool DAO' }] });
    expect(evaluate(r, ctx()).eligible).toBe(true);
  });

  it('skips a discord gated raffle for a guild that is not joined', () => {
    const r = raffle({ discordServerRoles: [{ id: 'guild-z' }] });
    expect(reasonOf(evaluate(r, ctx()))).toBe('discord_guild_not_joined');
  });

  it('ignores exclude-type discord entries when matching guilds', () => {
    const r = raffle({ discordServerRoles: [{ id: 'guild-a' }, { id: 'guild-z', exclude: true }] });
    expect(evaluate(r, ctx()).eligible).toBe(true);
  });

  it('accepts a raffle when at least one listed guild is known (default `any`)', () => {
    const r = raffle({ discordServerRoles: [{ id: 'guild-a' }, { id: 'guild-b' }] });
    expect(evaluate(r, ctx()).eligible).toBe(true);
  });

  it('requires every non-exclude guild under `all`', () => {
    const c = ctx({ config: config({}, { guildMatchMode: 'all' }) });
    const r = raffle({ discordServerRoles: [{ id: 'guild-a' }, { id: 'guild-b' }] });
    expect(reasonOf(evaluate(r, c))).toBe('discord_guild_not_joined');
  });

  it('rejects only when no listed guild is known', () => {
    const r = raffle({ discordServerRoles: [{ id: 'guild-y' }, { id: 'guild-z' }] });
    expect(reasonOf(evaluate(r, ctx()))).toBe('discord_guild_not_joined');
  });

  it('accepts a raffle whose only entries are exclusions', () => {
    const r = raffle({ discordServerRoles: [{ id: 'guild-z', exclude: true }] });
    expect(evaluate(r, ctx()).eligible).toBe(true);
  });

  it('names the missing servers so the owner knows which to join', () => {
    const r = raffle({
      discordServerRoles: [
        { id: 'guild-y', label: 'Snailies' },
        { id: 'guild-z', label: 'Rowdies' },
      ],
    });
    const result = evaluate(r, ctx());
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.detail).toBe('Snailies (guild-y), Rowdies (guild-z)');
    }
  });

  it('falls back to the raw id when a server has no label', () => {
    const r = raffle({ discordServerRoles: [{ id: 'guild-z' }] });
    const result = evaluate(r, ctx());
    if (!result.eligible) expect(result.detail).toBe('guild-z');
  });

  it('enters discord gated raffles when the whitelist is disabled', () => {
    const c = ctx({ config: config({}, { requireGuildWhitelist: false }) });
    const r = raffle({ discordServerRoles: [{ id: 'guild-z' }] });
    expect(evaluate(r, c).eligible).toBe(true);
  });

  it('skips everything discord-gated when no guilds are known at all', () => {
    const c = ctx({ knownGuildIds: new Set<string>() });
    const r = raffle({ discordServerRoles: [{ id: 'guild-a' }] });
    expect(reasonOf(evaluate(r, c))).toBe('discord_guild_not_joined');
  });

  it('skips poller raffles whose discord requirement cannot be resolved', () => {
    expect(reasonOf(evaluate(raffle({ reqString: 'd' }), ctx({ fromWebhook: false }))))
      .toBe('discord_requirements_unknown');
  });

  it('applies the poller fallback to discord role requirements too', () => {
    expect(reasonOf(evaluate(raffle({ reqString: 'r' }), ctx({ fromWebhook: false }))))
      .toBe('discord_requirements_unknown');
  });

  it('does not apply the poller fallback to webhook raffles', () => {
    const r = raffle({ reqString: 'd', discordServerRoles: [{ id: 'guild-a' }] });
    expect(evaluate(r, ctx()).eligible).toBe(true);
  });

  it('lets poller raffles without discord requirements through', () => {
    expect(evaluate(raffle({ reqString: 'ft' }), ctx({ fromWebhook: false })).eligible).toBe(true);
  });

  it('skips blockchains outside the allow list', () => {
    const c = ctx({ config: config({ allowedBlockchains: ['ethereum'] }) });
    expect(reasonOf(evaluate(raffle({ blockchain: 'solana' }), c))).toBe('blockchain_excluded');
  });

  it('matches the blockchain allow list case-insensitively', () => {
    const c = ctx({ config: config({ allowedBlockchains: ['Ethereum'] }) });
    expect(evaluate(raffle({ blockchain: 'ETHEREUM' }), c).eligible).toBe(true);
  });

  it('matches excluded keywords case-insensitively', () => {
    const c = ctx({ config: config({ excludeKeywords: ['TEST'] }) });
    expect(reasonOf(evaluate(raffle({ name: 'a test raffle' }), c))).toBe('keyword_excluded');
  });

  it('skips raffles with too few winners', () => {
    const c = ctx({ config: config({ minWinnerCount: 50 }) });
    expect(reasonOf(evaluate(raffle({ winnerCount: 10 }), c))).toBe('too_few_winners');
  });

  it('does not filter on twitter requirements', () => {
    const r = raffle({ reqString: 'flt', twitterFollows: [{ id: '1', name: 'x' }] });
    expect(evaluate(r, ctx()).eligible).toBe(true);
  });

  it('falls back to the current clock when no now is supplied', () => {
    const c = ctx();
    delete (c as { now?: number }).now;
    expect(evaluate(raffle({ endDate: Date.now() + 60_000 }), c).eligible).toBe(true);
  });
});
