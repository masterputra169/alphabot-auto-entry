import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EntryQueue } from '../../src/core/entry-queue.js';
import { AuthError } from '../../src/api/client.js';
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
    ...over,
  },
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
  const entered: string[] = [];
  const store = {
    has: (slug: string) => entered.includes(slug),
    record: vi.fn(async (r: { slug: string }) => { entered.push(r.slug); }),
  };
  const notifier = {
    entered: vi.fn(async () => {}), failed: vi.fn(async () => {}),
    skipped: vi.fn(async () => {}), won: vi.fn(async () => {}), fatal: vi.fn(async () => {}),
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
  return { queue, post, store, notifier };
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

  it('records the failure and notifies when validation fails', async () => {
    const post = vi.fn(async () => ({
      resultMd: 'Not in server', validation: { success: false, reason: 'discord_invalid' },
    }));
    const { queue, notifier, store } = harness({ client: { post, get: vi.fn() } });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    expect(notifier.failed).toHaveBeenCalledOnce();
    expect(store.record).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, reason: 'discord_invalid' }),
    );
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
    const store = { has: () => true, record: vi.fn(async () => {}) };
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
    const store = { has: () => false, record: vi.fn(async () => {}) };
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
});
