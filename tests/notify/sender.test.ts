import { describe, expect, it, vi } from 'vitest';
import { WebhookSender, type SenderOptions } from '../../src/notify/sender.js';

const URL_A = 'https://discord.com/api/webhooks/a';
const URL_B = 'https://discord.com/api/webhooks/b';

const accepted = () => new Response(null, { status: 204 });

/** A clock the test drives, so backoff and pacing never cost real seconds. */
function clock() {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
}

/** A sender whose fetch answers with the given responses in order. */
function make(responses: (() => Response | Promise<Response>)[], over: SenderOptions = {}) {
  const time = clock();
  let call = 0;
  const fetchImpl = vi.fn(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next!();
  });
  const sender = new WebhookSender({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: time.sleep,
    now: time.now,
    ...over,
  });
  return { sender, fetchImpl, time };
}

describe('WebhookSender', () => {
  it('reports success when discord accepts the post', async () => {
    const { sender, fetchImpl } = make([accepted]);

    await expect(sender.post(URL_A, { hello: 'world' })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('waits the time discord asks for and retries a 429', async () => {
    const { sender, fetchImpl, time } = make([
      () => new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }),
      accepted,
    ]);

    await expect(sender.post(URL_A, {})).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(time.slept[0]).toBeGreaterThanOrEqual(1500);
  });

  it('falls back to the Retry-After header when the body carries no delay', async () => {
    const { sender, time } = make([
      () => new Response(null, { status: 429, headers: { 'retry-after': '3' } }),
      accepted,
    ]);

    await expect(sender.post(URL_A, {})).resolves.toBe(true);
    expect(time.slept[0]).toBeGreaterThanOrEqual(3000);
  });

  it('retries a 500, because the payload was fine', async () => {
    const { sender, fetchImpl } = make([
      () => new Response('upstream down', { status: 500 }),
      accepted,
    ]);

    await expect(sender.post(URL_A, {})).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a network failure', async () => {
    const { sender, fetchImpl } = make([
      () => {
        throw new Error('offline');
      },
      accepted,
    ]);

    await expect(sender.post(URL_A, {})).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt limit and reports failure', async () => {
    const { sender, fetchImpl } = make(
      [() => new Response('nope', { status: 500 })],
      { maxAttempts: 3 },
    );

    await expect(sender.post(URL_A, {})).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 400, because discord will never accept that payload', async () => {
    const { sender, fetchImpl } = make([() => new Response('bad embed', { status: 400 })]);

    await expect(sender.post(URL_A, {})).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('consumes the response body so the connection is released', async () => {
    const held = new Response('{}', { status: 200 });
    const { sender } = make([() => held]);

    await sender.post(URL_A, {});

    expect(held.bodyUsed).toBe(true);
  });

  it('paces consecutive posts to one webhook under discord’s channel limit', async () => {
    const { sender, time } = make([accepted], { minIntervalMs: 2000 });

    await sender.post(URL_A, { n: 1 });
    await sender.post(URL_A, { n: 2 });

    expect(time.slept).toContain(2000);
  });

  it('does not make one channel wait for another', async () => {
    const { sender, time } = make([accepted], { minIntervalMs: 2000 });

    await sender.post(URL_A, {});
    await sender.post(URL_B, {});

    expect(time.slept).toHaveLength(0);
  });

  it('keeps alerts to one channel in the order they were raised', async () => {
    const { sender, fetchImpl } = make([accepted], { minIntervalMs: 0 });

    await Promise.all([
      sender.post(URL_A, { n: 1 }),
      sender.post(URL_A, { n: 2 }),
      sender.post(URL_A, { n: 3 }),
    ]);

    const sent = fetchImpl.mock.calls.map(
      (c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string).n,
    );
    expect(sent).toEqual([1, 2, 3]);
  });

  it('drops an alert rather than growing the backlog without limit', async () => {
    const { sender } = make([accepted], { minIntervalMs: 0, maxQueued: 2 });

    const results = await Promise.all([
      sender.post(URL_A, { n: 1 }),
      sender.post(URL_A, { n: 2 }),
      sender.post(URL_A, { n: 3 }),
    ]);

    expect(results).toEqual([true, true, false]);
  });

  it('posts the payload as json', async () => {
    const { sender, fetchImpl } = make([accepted]);

    await sender.post(URL_A, { content: 'hi' });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ content: 'hi' });
  });

  it('drains everything already queued, so a shutdown loses nothing', async () => {
    const { sender, fetchImpl } = make([accepted], { minIntervalMs: 0 });

    void sender.post(URL_A, { n: 1 });
    void sender.post(URL_A, { n: 2 });
    void sender.post(URL_B, { n: 3 });
    await sender.drain();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('backs off on its own when a 429 carries no delay it can read', async () => {
    const { sender, fetchImpl, time } = make([
      () => new Response('<html>too many requests</html>', { status: 429 }),
      accepted,
    ]);

    await expect(sender.post(URL_A, {})).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(time.slept[0]).toBeGreaterThan(0);
  });

  it('also drains alerts raised while it is already draining', async () => {
    const { sender, fetchImpl } = make([accepted], { minIntervalMs: 0 });

    void sender.post(URL_A, { n: 1 });
    const draining = sender.drain();
    void sender.post(URL_A, { n: 2 });
    await draining;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
