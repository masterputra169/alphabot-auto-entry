import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleEvent, type HandlerDeps } from '../../src/webhook/handlers.js';
import { EntryStore } from '../../src/core/store.js';
import type { WebhookBody } from '../../src/api/types.js';

const raffle = { _id: '1', slug: 'r1', name: 'R1', status: 'active' };

async function deps() {
  const queue = { submit: vi.fn() };
  const notifier = {
    entered: vi.fn(async () => {}), failed: vi.fn(async () => {}),
    skipped: vi.fn(async () => {}), won: vi.fn(async () => {}), fatal: vi.fn(async () => {}),
  };
  const store = await EntryStore.open(mkdtempSync(join(tmpdir(), 'abhook-')));
  return { queue, notifier, store, deps: { queue, notifier, store } as unknown as HandlerDeps };
}

const body = (over: Partial<WebhookBody>): WebhookBody => ({
  event: 'raffle:active', timestamp: 1, hash: 'h', ...over,
});

const won = () => body({ event: 'raffle:won', data: { raffle, entry: { mintAddress: '0x1' } } });

describe('handleEvent', () => {
  it('submits raffle:active to the queue as a webhook source', async () => {
    const d = await deps();
    await handleEvent(body({ event: 'raffle:active', data: { raffle } }), d.deps);
    expect(d.queue.submit).toHaveBeenCalledWith(raffle, 'webhook');
  });

  it('notifies on raffle:won', async () => {
    const d = await deps();
    await handleEvent(won(), d.deps);
    expect(d.notifier.won).toHaveBeenCalledWith(raffle, { mintAddress: '0x1' });
  });

  it('records the win so it is never retried', async () => {
    const d = await deps();
    await handleEvent(won(), d.deps);
    expect(d.store.wonCount).toBe(1);
    expect(d.store.isBlocked('r1')).toBe(true);
  });

  it('alerts once when alphabot redelivers the same win', async () => {
    const d = await deps();
    await handleEvent(won(), d.deps);
    await handleEvent(won(), d.deps);
    expect(d.notifier.won).toHaveBeenCalledOnce();
  });

  it('ignores raffle:won without a raffle payload', async () => {
    const d = await deps();
    await handleEvent(body({ event: 'raffle:won', data: {} }), d.deps);
    expect(d.notifier.won).not.toHaveBeenCalled();
  });

  it('ignores raffle:active without a raffle payload', async () => {
    const d = await deps();
    await handleEvent(body({ event: 'raffle:active', data: {} }), d.deps);
    expect(d.queue.submit).not.toHaveBeenCalled();
  });

  it('ignores unrelated events without throwing', async () => {
    const d = await deps();
    await expect(handleEvent(body({ event: 'project:minting' }), d.deps)).resolves.toBeUndefined();
    expect(d.queue.submit).not.toHaveBeenCalled();
  });

  it('acknowledges webhook:test without side effects', async () => {
    const d = await deps();
    await expect(handleEvent(body({ event: 'webhook:test' }), d.deps)).resolves.toBeUndefined();
    expect(d.queue.submit).not.toHaveBeenCalled();
    expect(d.notifier.won).not.toHaveBeenCalled();
  });
});
