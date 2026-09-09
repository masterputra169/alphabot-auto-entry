import { describe, expect, it, vi } from 'vitest';
import { Poller } from '../../src/core/poller.js';
import { AuthError, BudgetExhaustedError } from '../../src/api/client.js';
import type { AppConfig } from '../../src/config.js';

const config = (enabled = true) => ({
  poll: { enabled, intervalSeconds: 600, pageSize: 50 },
} as AppConfig);

function make(get: ReturnType<typeof vi.fn>, enabled = true) {
  const submit = vi.fn();
  const poller = new Poller({
    config: config(enabled),
    client: { get, post: vi.fn(), budgetRemaining: 27 } as never,
    queue: { submit },
  });
  return { poller, submit };
}

describe('Poller', () => {
  it('submits every raffle it finds and returns the count', async () => {
    const get = vi.fn(async () => ({ raffles: [{ slug: 'a' }, { slug: 'b' }] }));
    const { poller, submit } = make(get);

    await expect(poller.runOnce()).resolves.toBe(2);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledWith({ slug: 'a' }, 'poller');
  });

  it('uses the configured page size', async () => {
    const get = vi.fn(async () => ({ raffles: [] }));
    const { poller } = make(get);
    await poller.runOnce();
    expect(get).toHaveBeenCalledWith('raffles', expect.objectContaining({ pageSize: 50 }));
  });

  it('returns zero and does not throw when the GET budget is spent', async () => {
    const get = vi.fn(async () => { throw new BudgetExhaustedError('spent'); });
    const { poller, submit } = make(get);

    await expect(poller.runOnce()).resolves.toBe(0);
    expect(submit).not.toHaveBeenCalled();
    expect(poller.stopped).toBe(false);
  });

  it('stops permanently after an auth error', async () => {
    const get = vi.fn(async () => { throw new AuthError('bad key'); });
    const { poller } = make(get);

    poller.start();
    await poller.runOnce();
    expect(poller.stopped).toBe(true);
  });

  it('swallows unexpected errors so the interval survives', async () => {
    const get = vi.fn(async () => { throw new Error('network'); });
    const { poller } = make(get);
    await expect(poller.runOnce()).resolves.toBe(0);
    expect(poller.stopped).toBe(false);
  });

  it('does not start when polling is disabled', () => {
    const { poller } = make(vi.fn(), false);
    poller.start();
    poller.stop();
    expect(poller.stopped).toBe(false);
  });

  it('start is idempotent and stop clears the timer', async () => {
    const get = vi.fn(async () => ({ raffles: [] }));
    const { poller } = make(get);
    poller.start();
    poller.start();
    poller.stop();
    expect(poller.stopped).toBe(false);
  });
});
