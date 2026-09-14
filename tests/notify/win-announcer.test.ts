import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WinAnnouncer } from '../../src/notify/win-announcer.js';
import { EntryStore } from '../../src/core/store.js';
import type { RaffleForList } from '../../src/api/types.js';

const raffle = { _id: '1', slug: 'r1', name: 'R1', status: 'active' } as RaffleForList;

async function make(won = vi.fn(async () => true)) {
  const store = await EntryStore.open(mkdtempSync(join(tmpdir(), 'abwin-')));
  const announcer = new WinAnnouncer({
    store,
    notifier: { won } as never,
    intervalSeconds: 600,
  });
  return { store, announcer, won };
}

describe('WinAnnouncer', () => {
  it('announces a win and remembers that it landed', async () => {
    const { store, announcer, won } = await make();

    await announcer.announce(raffle, { mintAddress: '0x1' });

    expect(won).toHaveBeenCalledWith(raffle, { mintAddress: '0x1' });
    expect(store.wonCount).toBe(1);
    expect(store.pendingWins()).toHaveLength(0);
  });

  it('ignores a redelivery once the alert has landed', async () => {
    const { announcer, won } = await make();

    await announcer.announce(raffle, undefined);
    await announcer.announce(raffle, undefined);

    expect(won).toHaveBeenCalledOnce();
  });

  it('keeps the win recorded when its alert fails', async () => {
    const { store, announcer } = await make(vi.fn(async () => false));

    await announcer.announce(raffle, undefined);

    // The win happened whether or not anyone was told, and /health must say so.
    expect(store.wonCount).toBe(1);
    expect(store.isBlocked('r1')).toBe(true);
    expect(store.pendingWins().map((r) => r.slug)).toEqual(['r1']);
  });

  it('retries a win whose alert never landed', async () => {
    const won = vi.fn(async () => false);
    const { store, announcer } = await make(won);
    await announcer.announce(raffle, undefined);

    won.mockImplementation(async () => true);
    expect(await announcer.retryPending()).toBe(1);

    expect(store.pendingWins()).toHaveLength(0);
  });

  it('has nothing to retry once every alert has landed', async () => {
    const { announcer } = await make();
    await announcer.announce(raffle, undefined);

    expect(await announcer.retryPending()).toBe(0);
  });

  it('still announces a win whose redelivery collided with a failing attempt', async () => {
    // The failure both reviewers flagged: Alphabot redelivers while the first
    // attempt is still retrying, the redelivery is dropped as a duplicate, and
    // the first attempt then fails. Nothing may be lost by that pairing.
    let release: ((delivered: boolean) => void) | undefined;
    const won = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((r) => { release = r; }))
      .mockImplementation(async () => true);
    const { store, announcer } = await make(won as never);

    const first = announcer.announce(raffle, undefined);
    // Let the first attempt actually reach Discord before the redelivery lands.
    await vi.waitFor(() => expect(won).toHaveBeenCalledOnce());

    await announcer.announce(raffle, undefined);
    release?.(false);
    await first;

    expect(won).toHaveBeenCalledOnce();
    expect(store.pendingWins()).toHaveLength(1);
    expect(await announcer.retryPending()).toBe(1);
    expect(store.pendingWins()).toHaveLength(0);
  });

  it('announces once when two deliveries arrive together', async () => {
    const { announcer, won } = await make();

    await Promise.all([
      announcer.announce(raffle, undefined),
      announcer.announce(raffle, undefined),
    ]);

    expect(won).toHaveBeenCalledOnce();
  });

  it('never replays a win recorded before announcements were tracked', async () => {
    const { store, announcer, won } = await make();
    await store.record({
      slug: 'legacy', name: 'Legacy', at: 1, success: true, entries: 1, reason: null, won: true,
    });

    expect(await announcer.retryPending()).toBe(0);
    await announcer.announce({ ...raffle, slug: 'legacy', name: 'Legacy' }, undefined);

    expect(won).not.toHaveBeenCalled();
  });

  it('stops its timer when asked', async () => {
    const { announcer } = await make();
    announcer.start();
    expect(() => announcer.stop()).not.toThrow();
  });
});
