import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EntryQueue } from '../../src/core/entry-queue.js';
import { ApiError, AuthError } from '../../src/api/client.js';
import type { AppConfig } from '../../src/config.js';
import type { RaffleWithRequirements } from '../../src/api/types.js';

const config = (over: Partial<AppConfig['entry']> = {}): AppConfig => ({
  poll: {
    enabled: true, intervalSeconds: 600, pageSize: 50,
    resolveDiscordRequirements: true, maxResolvesPerCycle: 10,
  },
  entry: {
    delayMs: 700, dryRun: false, skipCaptcha: true, skipNftHolding: true,
    skipTokenGated: true, allowedBlockchains: [], excludeKeywords: [], minWinnerCount: 0,
    retryHours: 6, maxRetryHours: 24,
    ...over,
  },
  notify: { blockerDigestHours: 168, blockerDigestSize: 5 },
  discord: {
    requireGuildWhitelist: true, guildMatchMode: 'any',
    guildIds: [], refreshHours: 6,
  },
  submission: { mintAddress: null, discordId: null, twitterId: null, telegramId: null },
  env: { rafflePassword: null } as AppConfig['env'],
});

const raffle = (over: Partial<RaffleWithRequirements> = {}): RaffleWithRequirements => ({
  _id: '1', slug: 'r1', name: 'Raffle One', status: 'active',
  endDate: Date.now() + 60_000, winnerCount: 5, ...over,
});

function harness(over: Record<string, unknown> = {}) {
  const post = vi.fn(async () => ({ validation: { success: true, entries: 1 } }));
  const records = new Map<string, Record<string, unknown>>();
  const store = {
    isBlocked: (slug: string) => records.has(slug),
    get: (slug: string) => records.get(slug),
    record: vi.fn(async (r: { slug: string }) => { records.set(r.slug, r); }),
  };
  const notifier = {
    entered: vi.fn(async () => {}), failed: vi.fn(async () => {}),
    skipped: vi.fn(async () => {}), won: vi.fn(async () => {}), fatal: vi.fn(async () => {}),
    rejected: vi.fn(async () => {}),
  };
  const queue = new EntryQueue({
    config: config(),
    client: { post, get: vi.fn() },
    store,
    notifier,
    guilds: { getGuildIds: async () => new Set<string>(['guild-a']) },
    sleep: async () => {},
    ...over,
  } as never);
  return { queue, post, store, notifier, records };
}

beforeEach(() => vi.clearAllMocks());

describe('EntryQueue', () => {
  it('registers an eligible raffle and records it', async () => {
    const { queue, post, store, notifier } = harness();
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    expect(post).toHaveBeenCalledWith('register', { slug: 'r1' });
    expect(store.record).toHaveBeenCalledOnce();
    expect(notifier.entered).toHaveBeenCalledOnce();
  });

  it('does not register a filtered raffle', async () => {
    const { queue, post, notifier } = harness();
    queue.submit(raffle({ connectCaptcha: true }), 'webhook');
    await queue.idle();

    expect(post).not.toHaveBeenCalled();
    expect(notifier.skipped).toHaveBeenCalledOnce();
  });

  it('treats poller raffles as lacking full requirements', async () => {
    const { queue, post, notifier } = harness();
    queue.submit(raffle({ reqString: 'd' }), 'poller');
    await queue.idle();

    expect(post).not.toHaveBeenCalled();
    expect(notifier.skipped).toHaveBeenCalledWith(
      expect.anything(), 'discord_requirements_unknown', undefined,
    );
  });

  it('deduplicates the same slug submitted twice before processing', async () => {
    const { queue, post } = harness();
    queue.submit(raffle(), 'webhook');
    queue.submit(raffle(), 'poller');
    await queue.idle();
    expect(post).toHaveBeenCalledOnce();
  });

  it('processes sequentially with the configured delay', async () => {
    const sleep = vi.fn(async () => {});
    const { queue, post } = harness({ sleep });
    queue.submit(raffle({ slug: 'a' }), 'webhook');
    queue.submit(raffle({ slug: 'b' }), 'webhook');
    await queue.idle();

    expect(post).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(700);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('reports a validation failure as a rejection, not an error', async () => {
    const post = vi.fn(async () => ({
      resultMd: 'Not in server', validation: { success: false, reason: 'discord_invalid' },
    }));
    const { queue, notifier, store } = harness({ client: { post, get: vi.fn() } });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    // Rejections are expected and stay out of the Discord channel.
    expect(notifier.rejected).toHaveBeenCalledOnce();
    expect(notifier.failed).not.toHaveBeenCalled();
    expect(store.record).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, reason: 'discord_invalid' }),
    );
  });

  it('marks a validation rejection retryable', async () => {
    const post = vi.fn(async () => ({ validation: { success: false, reason: 'tasks' } }));
    const { queue, store } = harness({ client: { post, get: vi.fn() } });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    const record = store.record.mock.calls[0]?.[0] as { retryAfter: number | null };
    expect(record.retryAfter).toBeGreaterThan(Date.now());
  });

  it('marks a successful entry permanent', async () => {
    const { queue, store } = harness();
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    const record = store.record.mock.calls[0]?.[0] as { retryAfter: number | null };
    expect(record.retryAfter).toBeNull();
  });

  it('treats a declined registration as a retryable rejection', async () => {
    const post = vi.fn().mockRejectedValue(
      new ApiError('One or more tasks incomplete.', 200, true),
    );
    const { queue, store, notifier } = harness({ client: { post, get: vi.fn() } });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    expect(notifier.rejected).toHaveBeenCalledOnce();
    expect(notifier.failed).not.toHaveBeenCalled();
    const record = store.record.mock.calls[0]?.[0] as { retryAfter: number | null };
    expect(record.retryAfter).toBeGreaterThan(Date.now());
  });

  it('never reschedules a raffle that has already ended', async () => {
    const post = vi.fn(async () => ({
      validation: { success: false, reason: 'opportunity_ended' },
    }));
    const { queue, store } = harness({ client: { post, get: vi.fn() } });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    const record = store.record.mock.calls[0]?.[0] as { retryAfter: number | null };
    expect(record.retryAfter).toBeNull();
  });

  it('never reschedules a raffle that has already been won', async () => {
    const post = vi.fn(async () => ({
      validation: { success: false, reason: 'cannot_win_twice' },
    }));
    const { queue, store } = harness({ client: { post, get: vi.fn() } });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    const record = store.record.mock.calls[0]?.[0] as { retryAfter: number | null };
    expect(record.retryAfter).toBeNull();
  });

  it('keeps an unknown failure permanent so it cannot double-enter', async () => {
    const post = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const { queue, store, notifier } = harness({ client: { post, get: vi.fn() } });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    expect(notifier.failed).toHaveBeenCalledOnce();
    const record = store.record.mock.calls[0]?.[0] as { retryAfter: number | null };
    expect(record.retryAfter).toBeNull();
  });

  it('keeps a 500 permanent because the outcome is unknown', async () => {
    const post = vi.fn().mockRejectedValue(new ApiError('server error', 500, false));
    const { queue, store } = harness({ client: { post, get: vi.fn() } });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    const record = store.record.mock.calls[0]?.[0] as { retryAfter: number | null };
    expect(record.retryAfter).toBeNull();
  });

  it('records an api error without crashing the queue', async () => {
    const post = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ validation: { success: true, entries: 1 } });
    const { queue, notifier, store } = harness({ client: { post, get: vi.fn() } });
    queue.submit(raffle({ slug: 'a' }), 'webhook');
    queue.submit(raffle({ slug: 'b' }), 'webhook');
    await queue.idle();

    expect(notifier.failed).toHaveBeenCalledOnce();
    expect(store.record).toHaveBeenCalledTimes(2);
  });

  it('reports auth errors through onAuthError and stops entering', async () => {
    const post = vi.fn(async () => { throw new AuthError('bad key'); });
    const onAuthError = vi.fn();
    const { queue, notifier } = harness({ client: { post, get: vi.fn() }, onAuthError });
    queue.submit(raffle({ slug: 'a' }), 'webhook');
    queue.submit(raffle({ slug: 'b' }), 'webhook');
    await queue.idle();

    expect(onAuthError).toHaveBeenCalledOnce();
    expect(notifier.fatal).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
  });

  it('does not POST in dry run but still notifies', async () => {
    const { queue, post, notifier } = harness({ config: config({ dryRun: true }) });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    expect(post).not.toHaveBeenCalled();
    expect(notifier.entered).toHaveBeenCalledOnce();
  });

  it('skips a raffle the store already knows about', async () => {
    const store = { isBlocked: () => true, record: vi.fn(async () => {}) };
    const { queue, post, notifier } = harness({ store });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    expect(post).not.toHaveBeenCalled();
    expect(notifier.skipped).toHaveBeenCalledWith(
      expect.anything(), 'already_entered', undefined,
    );
  });

  it('passes configured submission overrides to register', async () => {
    const cfg = config();
    const withOverrides = {
      ...cfg,
      submission: { ...cfg.submission, mintAddress: '0xdead', twitterId: 'tw' },
    };
    const { queue, post } = harness({ config: withOverrides });
    queue.submit(raffle(), 'webhook');
    await queue.idle();
    expect(post).toHaveBeenCalledWith('register', {
      slug: 'r1', mintAddress: '0xdead', twitterId: 'tw',
    });
  });

  it('enters password gated raffles when a password is configured', async () => {
    const cfg = config();
    const withPassword = {
      ...cfg,
      env: { ...cfg.env, rafflePassword: 'hunter2' } as AppConfig['env'],
    };
    const { queue, post } = harness({ config: withPassword });
    queue.submit(raffle({ connectPassword: true }), 'webhook');
    await queue.idle();
    expect(post).toHaveBeenCalledOnce();
  });

  it('re-judges a raffle submitted again after processing', async () => {
    const { queue, post } = harness();

    queue.submit(raffle({ connectCaptcha: true }), 'poller');
    await queue.idle();
    expect(post).not.toHaveBeenCalled();

    // Same slug, now carrying data that makes it eligible.
    queue.submit(raffle(), 'poller');
    await queue.idle();
    expect(post).toHaveBeenCalledOnce();
  });

  it('reports a skip once, then again only when the reason changes', async () => {
    const { queue, notifier } = harness();

    queue.submit(raffle({ connectCaptcha: true }), 'webhook');
    await queue.idle();
    queue.submit(raffle({ connectCaptcha: true }), 'poller');
    await queue.idle();
    expect(notifier.skipped).toHaveBeenCalledOnce();

    queue.submit(raffle({ status: 'ended' }), 'poller');
    await queue.idle();
    expect(notifier.skipped).toHaveBeenCalledTimes(2);
  });

  it('re-enters a discord raffle once the guild becomes known', async () => {
    let guildIds = new Set<string>();
    const { queue, post, notifier } = harness({
      guilds: { getGuildIds: async () => guildIds },
    });
    const gated = () => raffle({ discordServerRoles: [{ id: 'guild-a' }] });

    queue.submit(gated(), 'poller');
    await queue.idle();
    expect(post).not.toHaveBeenCalled();
    expect(notifier.skipped).toHaveBeenCalledWith(
      expect.anything(), 'discord_guild_not_joined', 'guild-a',
    );

    // OAuth completes; the whitelist fills in without a restart.
    guildIds = new Set(['guild-a']);
    queue.submit(gated(), 'poller');
    await queue.idle();
    expect(post).toHaveBeenCalledOnce();
  });

  it('releases the in-flight guard even when entry throws', async () => {
    const post = vi.fn().mockRejectedValue(new Error('boom'));
    // A store that forgets, so the retry is not blocked by `already_entered`
    // and the test isolates the in-flight guard itself.
    const store = {
      isBlocked: () => false, get: () => undefined, record: vi.fn(async () => {}),
    };
    const { queue } = harness({ client: { post, get: vi.fn() }, store });

    queue.submit(raffle(), 'poller');
    await queue.idle();
    queue.submit(raffle(), 'poller');
    await queue.idle();

    expect(post).toHaveBeenCalledTimes(2);
  });

  it('does not retry an entry whose failure was recorded', async () => {
    const post = vi.fn().mockRejectedValue(new Error('boom'));
    const { queue } = harness({ client: { post, get: vi.fn() } });

    queue.submit(raffle(), 'poller');
    await queue.idle();
    queue.submit(raffle(), 'poller');
    await queue.idle();

    // Recorded failures stay recorded: re-registering could double-enter.
    expect(post).toHaveBeenCalledOnce();
  });

  it('reports queue depth', () => {
    const { queue } = harness();
    queue.submit(raffle({ slug: 'a' }), 'webhook');
    queue.submit(raffle({ slug: 'b' }), 'webhook');
    expect(queue.depth).toBeGreaterThan(0);
  });

  it('does not let a slow discord alert hold up the next entry', async () => {
    // Discord pacing must never decide how fast a first-come raffle is entered.
    const stalled = new Promise<boolean>(() => {});
    const { queue, post } = harness({
      notifier: {
        entered: vi.fn(() => stalled), failed: vi.fn(async () => true),
        skipped: vi.fn(async () => {}), won: vi.fn(async () => true),
        fatal: vi.fn(async () => true), rejected: vi.fn(async () => {}),
      },
    });

    queue.submit(raffle({ slug: 'first' }), 'webhook');
    queue.submit(raffle({ slug: 'second' }), 'webhook');
    await queue.idle();

    expect(post).toHaveBeenCalledTimes(2);
  });

  it('names the raffle whose alert discord never received', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { queue } = harness({
      notifier: {
        entered: vi.fn(async () => false), failed: vi.fn(async () => true),
        skipped: vi.fn(async () => {}), won: vi.fn(async () => true),
        fatal: vi.fn(async () => true), rejected: vi.fn(async () => {}),
      },
    });

    queue.submit(raffle({ slug: 'never-announced' }), 'webhook');
    await queue.idle();
    // The alert is deliberately not awaited, so let its report settle.
    await new Promise((r) => { setTimeout(r, 0); });

    expect(spy.mock.calls.flat().join(' ')).toContain('never-announced');
    spy.mockRestore();
  });

  it('never reports itself idle with work still queued', async () => {
    const { queue, post } = harness();

    queue.submit(raffle({ slug: 'a' }), 'webhook');
    queue.submit(raffle({ slug: 'b' }), 'poller');
    queue.submit(raffle({ slug: 'c' }), 'webhook');
    await queue.idle();

    expect(queue.depth).toBe(0);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('wakes again for work submitted after it had gone idle', async () => {
    const { queue, post } = harness();

    queue.submit(raffle({ slug: 'first' }), 'webhook');
    await queue.idle();
    queue.submit(raffle({ slug: 'second' }), 'webhook');
    await queue.idle();

    expect(queue.depth).toBe(0);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('waits longer each time a raffle is declined for the same reason', async () => {
    const post = vi.fn(async () => ({ validation: { success: false, reason: 'tasks' } }));
    const { queue, records } = harness({
      client: { post, get: vi.fn() },
      store: {
        isBlocked: () => false,
        get: (slug: string) => records.get(slug),
        record: vi.fn(async (r: { slug: string }) => { records.set(r.slug, r); }),
      },
    });

    queue.submit(raffle(), 'webhook');
    await queue.idle();
    const first = records.get('r1') as { retryAfter: number; attempts: number };

    queue.submit(raffle(), 'webhook');
    await queue.idle();
    const second = records.get('r1') as { retryAfter: number; attempts: number };

    expect(first.attempts).toBe(1);
    expect(second.attempts).toBe(2);
    expect(second.retryAfter - first.retryAfter).toBeGreaterThan(5 * 3_600_000);
  });

  it('starts the wait over when the reason changes', async () => {
    let reason = 'tasks';
    const post = vi.fn(async () => ({ validation: { success: false, reason } }));
    const { queue, records } = harness({
      client: { post, get: vi.fn() },
      store: {
        isBlocked: () => false,
        get: (slug: string) => records.get(slug),
        record: vi.fn(async (r: { slug: string }) => { records.set(r.slug, r); }),
      },
    });

    queue.submit(raffle(), 'webhook');
    await queue.idle();
    reason = 'something else';
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    expect((records.get('r1') as { attempts: number }).attempts).toBe(1);
  });

  it('never waits longer than the configured ceiling', async () => {
    const post = vi.fn(async () => ({ validation: { success: false, reason: 'tasks' } }));
    const { queue, records } = harness({
      config: config({ retryHours: 6, maxRetryHours: 12 }),
      client: { post, get: vi.fn() },
      store: {
        isBlocked: () => false,
        get: (slug: string) => records.get(slug),
        record: vi.fn(async (r: { slug: string }) => { records.set(r.slug, r); }),
      },
    });

    for (let i = 0; i < 5; i += 1) {
      queue.submit(raffle(), 'webhook');
      await queue.idle();
    }

    const record = records.get('r1') as { retryAfter: number };
    expect(record.retryAfter - Date.now()).toBeLessThanOrEqual(12 * 3_600_000 + 1000);
  });

  it('records the project, so sibling raffles can share one requirement lookup', async () => {
    const { queue, records } = harness();

    queue.submit(raffle({ projectId: 'proj-1' }), 'webhook');
    await queue.idle();

    expect((records.get('r1') as { projectId: string }).projectId).toBe('proj-1');
  });
});
