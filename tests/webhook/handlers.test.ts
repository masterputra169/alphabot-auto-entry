import { describe, expect, it, vi } from 'vitest';
import { handleEvent, type HandlerDeps } from '../../src/webhook/handlers.js';
import type { WebhookBody } from '../../src/api/types.js';

const raffle = { _id: '1', slug: 'r1', name: 'R1', status: 'active' };

function deps() {
  const queue = { submit: vi.fn() };
  const notifier = {
    entered: vi.fn(async () => {}), failed: vi.fn(async () => {}),
    skipped: vi.fn(async () => {}), won: vi.fn(async () => {}), fatal: vi.fn(async () => {}),
  };
  return { queue, notifier, deps: { queue, notifier } as unknown as HandlerDeps };
}

const body = (over: Partial<WebhookBody>): WebhookBody => ({
  event: 'raffle:active', timestamp: 1, hash: 'h', ...over,
});

describe('handleEvent', () => {
  it('submits raffle:active to the queue as a webhook source', async () => {
    const d = deps();
    await handleEvent(body({ event: 'raffle:active', data: { raffle } }), d.deps);
    expect(d.queue.submit).toHaveBeenCalledWith(raffle, 'webhook');
  });

  it('notifies on raffle:won', async () => {
    const d = deps();
    await handleEvent(
      body({ event: 'raffle:won', data: { raffle, entry: { mintAddress: '0x1' } } }),
      d.deps,
    );
    expect(d.notifier.won).toHaveBeenCalledWith(raffle, { mintAddress: '0x1' });
  });

  it('ignores raffle:won without a raffle payload', async () => {
    const d = deps();
    await handleEvent(body({ event: 'raffle:won', data: {} }), d.deps);
    expect(d.notifier.won).not.toHaveBeenCalled();
  });

  it('ignores raffle:active without a raffle payload', async () => {
    const d = deps();
    await handleEvent(body({ event: 'raffle:active', data: {} }), d.deps);
    expect(d.queue.submit).not.toHaveBeenCalled();
  });

  it('ignores unrelated events without throwing', async () => {
    const d = deps();
    await expect(handleEvent(body({ event: 'project:minting' }), d.deps)).resolves.toBeUndefined();
    expect(d.queue.submit).not.toHaveBeenCalled();
  });

  it('acknowledges webhook:test without side effects', async () => {
    const d = deps();
    await expect(handleEvent(body({ event: 'webhook:test' }), d.deps)).resolves.toBeUndefined();
    expect(d.queue.submit).not.toHaveBeenCalled();
    expect(d.notifier.won).not.toHaveBeenCalled();
  });
});
