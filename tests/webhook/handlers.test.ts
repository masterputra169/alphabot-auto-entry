import { describe, expect, it, vi } from 'vitest';
import { handleEvent, type HandlerDeps } from '../../src/webhook/handlers.js';
import type { WebhookBody } from '../../src/api/types.js';

const raffle = { _id: '1', slug: 'r1', name: 'R1', status: 'active' };

async function deps() {
  const queue = { submit: vi.fn() };
  const wins = { announce: vi.fn(async () => {}) };
  return { queue, wins, deps: { queue, wins } as unknown as HandlerDeps };
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

  it('hands raffle:won to the win announcer with its entry', async () => {
    const d = await deps();
    await handleEvent(won(), d.deps);
    expect(d.wins.announce).toHaveBeenCalledWith(raffle, { mintAddress: '0x1' });
  });

  it('ignores raffle:won without a raffle payload', async () => {
    const d = await deps();
    await handleEvent(body({ event: 'raffle:won', data: {} }), d.deps);
    expect(d.wins.announce).not.toHaveBeenCalled();
  });

  it('warns about a raffle:won it cannot act on, rather than dropping it silently', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = await deps();

    await handleEvent(body({ event: 'raffle:won', data: {} }), d.deps);

    expect(spy.mock.calls[0]?.join(' ')).toContain('raffle:won');
    spy.mockRestore();
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
    expect(d.wins.announce).not.toHaveBeenCalled();
  });

});
