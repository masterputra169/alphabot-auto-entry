import { describe, expect, it, vi } from 'vitest';
import { BlockerReport } from '../../src/core/blocker-report.js';
import { AuthError, BudgetExhaustedError } from '../../src/api/client.js';
import type { AppConfig } from '../../src/config.js';

const config = (over: Partial<AppConfig['poll']> = {}): AppConfig => ({
  poll: {
    enabled: true, intervalSeconds: 600, pageSize: 50,
    resolveDiscordRequirements: true, maxResolvesPerCycle: 10, ...over,
  },
} as AppConfig);

interface Options {
  blocked?: string[];
  requirements?: Record<string, {
    id: string; label?: string; exclude?: boolean;
    inviteLink?: string; roles?: { name?: string; val?: number }[];
  }[]>;
  budget?: number;
  poll?: Partial<AppConfig['poll']>;
  getImpl?: ReturnType<typeof vi.fn>;
}

function harness(over: Options = {}) {
  let blocked = over.blocked ?? [];
  const requirements = over.requirements ?? {};

  const get = over.getImpl ?? vi.fn(async (path: string) => {
    const slug = decodeURIComponent(path.replace('raffles/', ''));
    return { raffle: { slug, discordServerRoles: requirements[slug] } };
  });

  const client = { get, post: vi.fn(), budgetRemaining: over.budget ?? 27 };
  const report = new BlockerReport({
    config: config(over.poll),
    client: client as never,
    store: { blockedSlugs: () => blocked },
  });

  return { report, get, setBlocked: (s: string[]) => { blocked = s; } };
}

describe('BlockerReport', () => {
  it('names the servers holding raffles up and ranks them', async () => {
    const { report } = harness({
      blocked: ['a', 'b', 'c'],
      requirements: {
        a: [{ id: 'g1', label: 'ZeroLabs' }],
        b: [{ id: 'g1', label: 'ZeroLabs' }],
        c: [{ id: 'g2', label: 'Perrys' }],
      },
    });

    await report.refresh();

    expect(report.ranked).toEqual([
      { id: 'g1', label: 'ZeroLabs', raffles: 2, invite: null, roles: [] },
      { id: 'g2', label: 'Perrys', raffles: 1, invite: null, roles: [] },
    ]);
  });

  it('counts a raffle towards every server it requires', async () => {
    const { report } = harness({
      blocked: ['a'],
      requirements: { a: [{ id: 'g1', label: 'One' }, { id: 'g2', label: 'Two' }] },
    });
    await report.refresh();
    expect(report.ranked.map((s) => s.id).sort()).toEqual(['g1', 'g2']);
  });

  it('ignores servers marked as exclusions', async () => {
    const { report } = harness({
      blocked: ['a'],
      requirements: { a: [{ id: 'g1', label: 'Wanted' }, { id: 'g2', exclude: true }] },
    });
    await report.refresh();
    expect(report.ranked).toEqual([
      { id: 'g1', label: 'Wanted', raffles: 1, invite: null, roles: [] },
    ]);
  });

  it('falls back to the id when a server has no label', async () => {
    const { report } = harness({ blocked: ['a'], requirements: { a: [{ id: 'g1' }] } });
    await report.refresh();
    expect(report.ranked[0]?.label).toBe('g1');
  });

  it('reports the role a server asks for, and its invite', async () => {
    const { report } = harness({
      blocked: ['a'],
      requirements: {
        a: [{
          id: 'g1', label: 'Surge Alpha',
          inviteLink: 'https://discord.gg/surge',
          roles: [{ name: 'Verified' }],
        }],
      },
    });

    await report.refresh();

    expect(report.ranked[0]).toEqual({
      id: 'g1', label: 'Surge Alpha', raffles: 1,
      invite: 'https://discord.gg/surge', roles: [{ name: 'Verified', val: null }],
    });
  });

  it('marks a server as membership-only when no role is named', async () => {
    const { report } = harness({
      blocked: ['a'], requirements: { a: [{ id: 'g1', label: 'Open', roles: [] }] },
    });
    await report.refresh();
    expect(report.ranked[0]?.roles).toEqual([]);
  });

  it('merges the distinct roles different raffles ask for in one server', async () => {
    const { report } = harness({
      blocked: ['a', 'b', 'c'],
      requirements: {
        a: [{ id: 'g1', label: 'S', roles: [{ name: 'Verified', val: 1 }] }],
        b: [{ id: 'g1', label: 'S', roles: [
          { name: 'Verified', val: 1 }, { name: 'OG', val: 5 },
        ] }],
        c: [{ id: 'g1', label: 'S', roles: [] }],
      },
    });

    await report.refresh();

    expect(report.ranked[0]?.raffles).toBe(3);
    expect(report.ranked[0]?.roles.map((r) => r.name)).toEqual(['Verified', 'OG']);
  });

  it('lists roles cheapest first, so the basic one is obvious', async () => {
    const { report } = harness({
      blocked: ['a'],
      requirements: {
        a: [{
          id: 'g1', label: 'Surge Alpha',
          roles: [
            { name: 'Surge Gods', val: 10 },
            { name: 'Waiting Room', val: 1 },
            { name: 'VIP Surge', val: 5 },
          ],
        }],
      },
    });

    await report.refresh();

    // Alphabot treats these as alternatives with different entry weights,
    // so the lowest multiplier is the cheapest way in.
    expect(report.ranked[0]?.roles).toEqual([
      { name: 'Waiting Room', val: 1 },
      { name: 'VIP Surge', val: 5 },
      { name: 'Surge Gods', val: 10 },
    ]);
  });

  it('sorts a role with no multiplier last', async () => {
    const { report } = harness({
      blocked: ['a'],
      requirements: {
        a: [{ id: 'g1', roles: [{ name: 'Unknown' }, { name: 'Basic', val: 2 }] }],
      },
    });
    await report.refresh();
    expect(report.ranked[0]?.roles.map((r) => r.name)).toEqual(['Basic', 'Unknown']);
  });

  it('looks up each raffle only once across cycles', async () => {
    const { report, get } = harness({
      blocked: ['a'], requirements: { a: [{ id: 'g1', label: 'One' }] },
    });

    await report.refresh();
    await report.refresh();
    await report.refresh();

    expect(get).toHaveBeenCalledOnce();
  });

  it('honours maxResolvesPerCycle and reports what is left', async () => {
    const blocked = ['a', 'b', 'c', 'd'];
    const requirements = Object.fromEntries(
      blocked.map((s) => [s, [{ id: 'g1', label: 'One' }]]),
    );
    const { report, get } = harness({ blocked, requirements, poll: { maxResolvesPerCycle: 2 } });

    await report.refresh();

    expect(get).toHaveBeenCalledTimes(2);
    expect(report.pending).toBe(2);

    await report.refresh();
    expect(get).toHaveBeenCalledTimes(4);
    expect(report.pending).toBe(0);
  });

  it('keeps a budget reserve for the poller', async () => {
    const { report, get } = harness({
      blocked: ['a'], requirements: { a: [{ id: 'g1' }] }, budget: 4,
    });
    await report.refresh();
    expect(get).not.toHaveBeenCalled();
    expect(report.ranked).toEqual([]);
  });

  it('stops the cycle when the budget runs out mid-way', async () => {
    const getImpl = vi.fn(async () => { throw new BudgetExhaustedError('spent'); });
    const { report } = harness({ blocked: ['a', 'b'], getImpl });
    await expect(report.refresh()).resolves.toBeUndefined();
    // Not marked examined, so a later cycle retries them.
    expect(report.pending).toBe(2);
  });

  it('stops on an auth error without throwing', async () => {
    const getImpl = vi.fn(async () => { throw new AuthError('bad key'); });
    const { report } = harness({ blocked: ['a'], getImpl });
    await expect(report.refresh()).resolves.toBeUndefined();
    expect(report.ranked).toEqual([]);
  });

  it('does not retry a raffle whose lookup failed for another reason', async () => {
    const getImpl = vi.fn(async () => { throw new Error('boom'); });
    const { report } = harness({ blocked: ['a'], getImpl });

    await report.refresh();
    await report.refresh();

    expect(getImpl).toHaveBeenCalledOnce();
  });

  it('drops a raffle from the ranking once it is no longer blocked', async () => {
    const { report, setBlocked } = harness({
      blocked: ['a', 'b'],
      requirements: {
        a: [{ id: 'g1', label: 'One' }],
        b: [{ id: 'g1', label: 'One' }],
      },
    });

    await report.refresh();
    expect(report.ranked[0]?.raffles).toBe(2);

    // The owner joined the server and one raffle went through.
    setBlocked(['b']);
    expect(report.ranked[0]?.raffles).toBe(1);
  });

  it('reports nothing before any lookup has happened', () => {
    const { report } = harness({ blocked: ['a'] });
    expect(report.ranked).toEqual([]);
    expect(report.pending).toBe(1);
  });

  it('does not start a timer when polling is disabled', () => {
    const { report } = harness({ poll: { enabled: false } });
    report.start();
    report.stop();
    expect(report.ranked).toEqual([]);
  });
});
