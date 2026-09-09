import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { computeHash, verifyWebhook } from '../../src/webhook/verify.js';

const KEY = 'alphabot-test-key';

function signed(event: string, timestamp: number, key = KEY) {
  const hash = createHmac('sha256', key).update(`${event}\n${timestamp}`).digest('hex');
  return { event, timestamp, hash, data: {} };
}

describe('computeHash', () => {
  it('matches the documented event + linebreak + timestamp construction', () => {
    const expected = createHmac('sha256', KEY).update('raffle:active\n1700000000000').digest('hex');
    expect(computeHash('raffle:active', 1_700_000_000_000, KEY)).toBe(expected);
  });
});

describe('verifyWebhook', () => {
  it('accepts a correctly signed body', () => {
    expect(verifyWebhook(signed('raffle:active', 1234), KEY)).toBe(true);
  });

  it('rejects a body signed with a different key', () => {
    expect(verifyWebhook(signed('raffle:active', 1234, 'wrong-key'), KEY)).toBe(false);
  });

  it('rejects a tampered event name', () => {
    const body = signed('raffle:active', 1234);
    expect(verifyWebhook({ ...body, event: 'raffle:won' }, KEY)).toBe(false);
  });

  it('rejects a tampered timestamp', () => {
    const body = signed('raffle:active', 1234);
    expect(verifyWebhook({ ...body, timestamp: 9999 }, KEY)).toBe(false);
  });

  it('rejects a hash of the wrong length without throwing', () => {
    const body = signed('raffle:active', 1234);
    expect(verifyWebhook({ ...body, hash: 'abc' }, KEY)).toBe(false);
  });

  it.each([
    null,
    undefined,
    'string',
    42,
    {},
    { event: 'x', timestamp: 1 },
    { event: 'x', hash: 'y' },
    { event: 1, timestamp: 1, hash: 'y' },
    { event: 'x', timestamp: '1', hash: 'y' },
  ])('rejects malformed body %#', (body) => {
    expect(verifyWebhook(body, KEY)).toBe(false);
  });
});
