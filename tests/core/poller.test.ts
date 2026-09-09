import { describe, expect, it, vi } from 'vitest';
import { Poller } from '../../src/core/poller.js';
import { AuthError, BudgetExhaustedError } from '../../src/api/client.js';
import type { AppConfig } from '../../src/config.js';
import type { RaffleForList, RaffleWithRequirements } from '../../src/api/types.js';

const config = (
  poll: Partial<AppConfig['poll']> = {},
  discord: Partial<AppConfig['discord']> = {},
): AppConfig => ({
  poll: {
    enabled: true, intervalSeconds: 600, pageSize: 50,
    resolveDiscordRequirements: true, maxResolvesPerCycle: 10, ...poll,
  },
  discord: {
    requireGuildWhitelist: true, guildMatchMode: 'any',
    guildIds: [], refreshHours: 6, ...discord,
  },
} as AppConfig);

interface HarnessOptions {
  list?: RaffleForList[];
  single?: Record<string, RaffleWithRequirements>;
  budget?: number;
  entered?: string[];
  poll?: Partial<AppConfig['poll']>;
  discord?: Partial<AppConfig['discord']>;
  getImpl?: ReturnType<typeof vi.fn>;
}

function harness(over: HarnessOptions = {}) {
  const list = over.list ?? [];
  const single = over.single ?? {};
  const entered = over.entered ?? [];

  const get = over.getImpl ?? vi.fn(async (path: string) => {
    if (path === 'raffles') return { raffles: list };
    const slug = decodeURIComponent(path.replace('raffles/', ''));
    return { raffle: single[slug] };
  });

  const client = { get, post: vi.fn(), budgetRemaining: over.budget ?? 27 };
  const submit = vi.fn();
  const poller = new Poller({
    config: config(over.poll, over.discord),
    client: client as never,
    queue: { submit },
    store: { has: (slug: string) => entered.includes(slug) },
  });

  return { poller, submit, get, client };
}

const listed = (slug: string, reqString?: string): RaffleForList =>
  ({ _id: slug, slug, name: slug, status: 'active', reqString } as RaffleForList);

const resolvedRaffle = (slug: string, guildId: string): RaffleWithRequirements =>
  ({
    _id: slug, slug, name: slug, status: 'active', reqString: 'd',
    discordServerRoles: [{ id: guildId }],
  } as RaffleWithRequirements);

const resolveCalls = (get: ReturnType<typeof vi.fn>) =>
  get.mock.calls.filter((c) => (c[0] as string) !== 'raffles');

describe('Poller basics', () => {
  it('submits every raffle it finds and returns the count', async () => {
    const { poller, submit } = harness({ list: [listed('a'), listed('b')] });

    await expect(poller.runOnce()).resolves.toBe(2);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ slug: 'a' }), 'poller');
  });

  it('uses the configured page size', async () => {
    const { poller, get } = harness();
    await poller.runOnce();
    expect(get).toHaveBeenCalledWith('raffles', expect.objectContaining({ pageSize: 50 }));
  });

  it('returns zero and does not throw when the GET budget is spent', async () => {
    const getImpl = vi.fn(async () => { throw new BudgetExhaustedError('spent'); });
    const { poller, submit } = harness({ getImpl });

    await expect(poller.runOnce()).resolves.toBe(0);
    expect(submit).not.toHaveBeenCalled();
    expect(poller.stopped).toBe(false);
  });

  it('stops permanently after an auth error while listing', async () => {
    const getImpl = vi.fn(async () => { throw new AuthError('bad key'); });
    const { poller } = harness({ getImpl });

    poller.start();
    await poller.runOnce();
    expect(poller.stopped).toBe(true);
  });

  it('swallows unexpected errors so the interval survives', async () => {
    const getImpl = vi.fn(async () => { throw new Error('network'); });
    const { poller } = harness({ getImpl });
    await expect(poller.runOnce()).resolves.toBe(0);
    expect(poller.stopped).toBe(false);
  });

  it('does not start when polling is disabled', () => {
    const { poller } = harness({ poll: { enabled: false } });
    poller.start();
    poller.stop();
    expect(poller.stopped).toBe(false);
  });

  it('start is idempotent and stop clears the timer', async () => {
    const { poller } = harness();
    poller.start();
    poller.start();
    poller.stop();
    expect(poller.stopped).toBe(false);
  });
});

describe('Poller discord requirement resolution', () => {
  it('resolves a discord-gated raffle and submits the enriched object', async () => {
    const { poller, submit, get } = harness({
      list: [listed('gated', 'd')],
      single: { gated: resolvedRaffle('gated', 'guild-a') },
    });

    await poller.runOnce();

    expect(resolveCalls(get)).toHaveLength(1);
    expect(get).toHaveBeenCalledWith('raffles/gated', { requirements: 'true' });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ discordServerRoles: [{ id: 'guild-a' }] }),
      'poller',
    );
  });

  it('resolves role-gated raffles too', async () => {
    const { poller, get } = harness({
      list: [listed('roled', 'r')],
      single: { roled: resolvedRaffle('roled', 'guild-a') },
    });
    await poller.runOnce();
    expect(resolveCalls(get)).toHaveLength(1);
  });

  it('does not resolve raffles with no discord requirement', async () => {
    const { poller, get, submit } = harness({ list: [listed('open', 'ft')] });
    await poller.runOnce();
    expect(resolveCalls(get)).toHaveLength(0);
    expect(submit).toHaveBeenCalledOnce();
  });

  it('does not resolve a raffle already recorded in the store', async () => {
    const { poller, get } = harness({
      list: [listed('gated', 'd')],
      single: { gated: resolvedRaffle('gated', 'guild-a') },
      entered: ['gated'],
    });
    await poller.runOnce();
    expect(resolveCalls(get)).toHaveLength(0);
  });

  it('resolves each slug only once across cycles', async () => {
    const { poller, get } = harness({
      list: [listed('gated', 'd')],
      single: { gated: resolvedRaffle('gated', 'guild-a') },
    });

    await poller.runOnce();
    await poller.runOnce();
    await poller.runOnce();

    expect(resolveCalls(get)).toHaveLength(1);
  });

  it('re-submits the enriched raffle on later cycles, not the bare listing', async () => {
    const { poller, submit, get } = harness({
      list: [listed('gated', 'd')],
      single: { gated: resolvedRaffle('gated', 'guild-a') },
    });

    await poller.runOnce();
    await poller.runOnce();

    expect(resolveCalls(get)).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(2);
    for (const call of submit.mock.calls) {
      expect(call[0]).toHaveProperty('discordServerRoles', [{ id: 'guild-a' }]);
    }
  });

  it('forgets requirements once the raffle is no longer active', async () => {
    const single = { gated: resolvedRaffle('gated', 'guild-a') };
    const listRef: RaffleForList[] = [listed('gated', 'd')];
    const get = vi.fn(async (path: string) => {
      if (path === 'raffles') return { raffles: listRef };
      const slug = decodeURIComponent(path.replace('raffles/', ''));
      return { raffle: single[slug as keyof typeof single] };
    });
    const { poller } = harness({ getImpl: get });

    await poller.runOnce();
    listRef.length = 0;
    await poller.runOnce();
    listRef.push(listed('gated', 'd'));
    await poller.runOnce();

    // Cache was pruned while inactive, but the slug stays in `attempted`,
    // so no second GET is spent on it.
    expect(resolveCalls(get)).toHaveLength(1);
  });

  it('honours maxResolvesPerCycle', async () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map((s) => listed(s, 'd'));
    const single = Object.fromEntries(list.map((r) => [r.slug, resolvedRaffle(r.slug, 'g')]));
    const { poller, get, submit } = harness({ list, single, poll: { maxResolvesPerCycle: 2 } });

    await poller.runOnce();

    expect(resolveCalls(get)).toHaveLength(2);
    expect(submit).toHaveBeenCalledTimes(5);
  });

  it('retries the deferred ones on the next cycle', async () => {
    const list = ['a', 'b', 'c'].map((s) => listed(s, 'd'));
    const single = Object.fromEntries(list.map((r) => [r.slug, resolvedRaffle(r.slug, 'g')]));
    const { poller, get } = harness({ list, single, poll: { maxResolvesPerCycle: 2 } });

    await poller.runOnce();
    await poller.runOnce();

    expect(resolveCalls(get)).toHaveLength(3);
  });

  it('keeps a budget reserve so the next list call always fits', async () => {
    const { poller, get, submit } = harness({
      list: [listed('gated', 'd')],
      single: { gated: resolvedRaffle('gated', 'guild-a') },
      budget: 4,
    });

    await poller.runOnce();

    expect(resolveCalls(get)).toHaveLength(0);
    expect(submit).toHaveBeenCalledOnce();
  });

  it('does not resolve when the feature is switched off', async () => {
    const { poller, get } = harness({
      list: [listed('gated', 'd')],
      poll: { resolveDiscordRequirements: false },
    });
    await poller.runOnce();
    expect(resolveCalls(get)).toHaveLength(0);
  });

  it('does not resolve when the guild whitelist is not required', async () => {
    const { poller, get } = harness({
      list: [listed('gated', 'd')],
      discord: { requireGuildWhitelist: false },
    });
    await poller.runOnce();
    expect(resolveCalls(get)).toHaveLength(0);
  });

  it('submits unresolved and retries later when the budget runs out mid-cycle', async () => {
    const getImpl = vi.fn(async (path: string) => {
      if (path === 'raffles') return { raffles: [listed('gated', 'd')] };
      throw new BudgetExhaustedError('spent');
    });
    const { poller, submit } = harness({ getImpl });

    await poller.runOnce();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ slug: 'gated' }), 'poller');

    // Not marked resolved, so the next cycle tries again.
    await poller.runOnce();
    expect(getImpl.mock.calls.filter((c) => c[0] !== 'raffles')).toHaveLength(2);
  });

  it('does not retry a slug whose resolution failed for another reason', async () => {
    const getImpl = vi.fn(async (path: string) => {
      if (path === 'raffles') return { raffles: [listed('gated', 'd')] };
      throw new Error('server exploded');
    });
    const { poller } = harness({ getImpl });

    await poller.runOnce();
    await poller.runOnce();

    expect(getImpl.mock.calls.filter((c) => c[0] !== 'raffles')).toHaveLength(1);
  });

  it('halts on an auth error raised while resolving', async () => {
    const getImpl = vi.fn(async (path: string) => {
      if (path === 'raffles') return { raffles: [listed('gated', 'd')] };
      throw new AuthError('bad key');
    });
    const { poller } = harness({ getImpl });

    await expect(poller.runOnce()).resolves.toBe(0);
    expect(poller.stopped).toBe(true);
  });

  it('still submits the listed raffle when resolution returns nothing', async () => {
    const { poller, submit } = harness({
      list: [listed('gated', 'd')],
      single: {},
    });
    await poller.runOnce();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ slug: 'gated' }), 'poller');
  });
});
