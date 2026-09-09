import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookBody } from '../api/types.js';

/**
 * Alphabot signs webhooks as HMAC-SHA256 over `event + "\n" + timestamp`,
 * keyed with the account's API key.
 */
export function computeHash(event: string, timestamp: number, apiKey: string): string {
  return createHmac('sha256', apiKey).update(`${event}\n${timestamp}`).digest('hex');
}

export function verifyWebhook(body: unknown, apiKey: string): body is WebhookBody {
  if (typeof body !== 'object' || body === null) return false;

  const candidate = body as Record<string, unknown>;
  if (typeof candidate.event !== 'string') return false;
  if (typeof candidate.timestamp !== 'number') return false;
  if (typeof candidate.hash !== 'string') return false;

  const expected = Buffer.from(computeHash(candidate.event, candidate.timestamp, apiKey), 'utf8');
  const received = Buffer.from(candidate.hash, 'utf8');
  if (expected.length !== received.length) return false;

  return timingSafeEqual(expected, received);
}
