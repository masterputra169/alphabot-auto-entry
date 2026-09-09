import { describe, expect, it, vi } from 'vitest';
import {
  AlphabotClient, ApiError, AuthError, BudgetExhaustedError, TokenBucket,
} from '../../src/api/client.js';

const noSleep = async () => {};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeClient(fetchImpl: unknown, extra: Record<string, unknown> = {}) {
  return new AlphabotClient({
    apiKey: 'test-key',
    fetchImpl: fetchImpl as typeof fetch,
    sleep: noSleep,
    ...extra,
  });
}

describe('TokenBucket', () => {
  it('allows exactly `capacity` takes inside the window', () => {
    const bucket = new TokenBucket(3, 3_600_000);
    expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(0)).toBe(false);
  });

  it('refills once the oldest take falls out of the window', () => {
    const bucket = new TokenBucket(1, 1000);
    expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(999)).toBe(false);
    expect(bucket.tryTake(1001)).toBe(true);
  });

  it('reports how many takes remain', () => {
    const bucket = new TokenBucket(2, 60_000);
    bucket.tryTake();
    expect(bucket.available).toBe(1);
  });
});

describe('AlphabotClient', () => {
  it('sends the bearer token and unwraps the data envelope', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: { ok: 1 } }));
    const client = makeClient(fetchImpl);

    const result = await client.get<{ ok: number }>('raffles', { status: 'active' });

    expect(result).toEqual({ ok: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.alphabot.app/v1/raffles?status=active');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
  });

  it('omits undefined query values', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: {} }));
    const client = makeClient(fetchImpl);
    await client.get('raffles', { status: 'active', pageNum: undefined });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.alphabot.app/v1/raffles?status=active');
  });

  it('throws AuthError on 401 without retrying', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: false }, 401));
    const client = makeClient(fetchImpl);
    await expect(client.get('raffles')).rejects.toBeInstanceOf(AuthError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws AuthError on 403 as well', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: false }, 403));
    await expect(makeClient(fetchImpl).get('raffles')).rejects.toBeInstanceOf(AuthError);
  });

  it('retries a 500 and succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: false }, 500))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: true } }));
    const client = makeClient(fetchImpl);
    await expect(client.get('raffles')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries on persistent 500s', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: false }, 500));
    const client = makeClient(fetchImpl, { maxRetries: 1 });
    await expect(client.get('raffles')).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries network failures', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: 'ok' }));
    await expect(makeClient(fetchImpl).get('raffles')).resolves.toBe('ok');
  });

  it('honours Retry-After on 429 and retries', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: false }, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: 'ok' }));
    const client = makeClient(fetchImpl, { sleep });
    await expect(client.get('raffles')).resolves.toBe('ok');
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('falls back to a 5s backoff when Retry-After is missing', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: false }, 429))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: 'ok' }));
    await makeClient(fetchImpl, { sleep }).get('raffles');
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('throws ApiError with the server message on 400', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: false, errors: [{ message: 'bad slug' }] }, 400));
    const client = makeClient(fetchImpl);
    await expect(client.post('register', { slug: 'x' })).rejects.toThrow(/bad slug/);
  });

  it('throws ApiError when the envelope reports failure on a 200', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: false }, 200));
    await expect(makeClient(fetchImpl).post('register', {}))
      .rejects.toBeInstanceOf(ApiError);
  });

  it('marks an envelope failure as declined, so callers may retry it', async () => {
    // Alphabot refuses a registration with HTTP 200 and success:false.
    const fetchImpl = vi.fn(async () => jsonResponse(
      { success: false, errors: [{ message: 'One or more tasks incomplete.' }] }, 200,
    ));
    await expect(makeClient(fetchImpl).post('register', {}))
      .rejects.toMatchObject({ declined: true, status: 200 });
  });

  it('does not mark a 5xx as declined, since the outcome is unknown', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: false }, 500));
    await expect(makeClient(fetchImpl, { maxRetries: 0 }).get('raffles'))
      .rejects.toMatchObject({ declined: false });
  });

  it('refuses a GET once the hourly budget is spent', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: 1 }));
    const client = makeClient(fetchImpl, { getBucket: new TokenBucket(1, 3_600_000) });
    await client.get('raffles');
    await expect(client.get('raffles')).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not spend GET budget on POST', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: 1 }));
    const client = makeClient(fetchImpl, { getBucket: new TokenBucket(1, 3_600_000) });
    await client.post('register', {});
    await client.post('register', {});
    expect(client.budgetRemaining).toBe(1);
  });
});
