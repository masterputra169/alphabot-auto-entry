import { log } from '../logger.js';

/**
 * Discord allows roughly 30 messages a minute into one channel. A burst of
 * entries used to outrun that and the rejected alerts were simply discarded,
 * so posts to a given webhook are spaced to sit just under the ceiling.
 */
const DEFAULT_MIN_INTERVAL_MS = 2_100;
/**
 * A win is the one alert worth being stubborn about, and a redelivery that
 * arrives mid-retry is dropped as a duplicate. Succeeding on our own attempt
 * is therefore worth more than saving the attempt budget.
 */
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MAX_QUEUED = 100;
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;
/** Added to whatever Discord asks for, so a retry never lands on the boundary. */
const RETRY_AFTER_BUFFER_MS = 250;

export interface SenderOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Smallest gap between two posts to the same webhook. */
  minIntervalMs?: number;
  /** Tries allowed per notification, the first one included. */
  maxAttempts?: number;
  /** Notifications that may wait on one webhook before the next is refused. */
  maxQueued?: number;
}

/** One attempt either settled the notification or asked to be repeated. */
type Attempt =
  | { done: true; ok: boolean }
  | { done: false; reason: string; waitMs: number | null };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long Discord asked us to wait, from its header or its body. */
function retryAfterMs(response: Response, body: string): number | null {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds)) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) + RETRY_AFTER_BUFFER_MS;
  }

  try {
    const parsed: unknown = JSON.parse(body);
    const value = typeof parsed === 'object' && parsed !== null
      ? (parsed as { retry_after?: unknown }).retry_after
      : undefined;
    if (typeof value === 'number') {
      return Math.min(value * 1000, MAX_RETRY_AFTER_MS) + RETRY_AFTER_BUFFER_MS;
    }
  } catch {
    // Not JSON at all. The caller falls back to its own backoff.
  }
  return null;
}

/**
 * Delivers webhook payloads as reliably as a fire-and-forget channel allows.
 *
 * Posts to one webhook are chained rather than fired in parallel, so they keep
 * their order and can be paced; a rejection that might succeed later is
 * retried. The old sender logged a failure and dropped the message, which is
 * why an alert could vanish with nothing but a warning behind it.
 */
export class WebhookSender {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly maxQueued: number;

  /** Per webhook: the tail of the send chain, and when it last posted. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly queued = new Map<string, number>();

  constructor(options: SenderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
  }

  /** Queues one payload and resolves with whether Discord accepted it. */
  post(url: string, payload: unknown): Promise<boolean> {
    const depth = this.queued.get(url) ?? 0;
    if (depth >= this.maxQueued) {
      log.error('Dropped a Discord notification: too many are already waiting', { depth });
      return Promise.resolve(false);
    }
    this.queued.set(url, depth + 1);

    const previous = this.chains.get(url) ?? Promise.resolve();
    const result = previous.then(() => this.deliver(url, payload));
    // The chain must survive a failed delivery, or one error would strand
    // every alert queued behind it.
    this.chains.set(url, result.then(() => undefined, () => undefined));

    return result
      .catch(() => false)
      .finally(() => this.queued.set(url, (this.queued.get(url) ?? 1) - 1));
  }

  /**
   * Resolves once everything queued has been posted. Pacing means alerts can
   * be waiting when a shutdown arrives, and those are exactly the ones worth
   * waiting for.
   */
  async drain(): Promise<void> {
    // An alert can be raised while earlier ones are still going out, so this
    // waits for whatever is outstanding now rather than only for the batch
    // that happened to be queued when it was called.
    while (this.pending > 0) {
      await Promise.all([...this.chains.values()]);
    }
  }

  /** Alerts queued across every webhook, delivered or not. */
  private get pending(): number {
    let total = 0;
    for (const depth of this.queued.values()) total += depth;
    return total;
  }

  private async deliver(url: string, payload: unknown): Promise<boolean> {
    const body = JSON.stringify(payload);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      await this.pace(url);

      const result = await this.attempt(url, body);
      if (result.done) return result.ok;

      if (attempt >= this.maxAttempts) {
        log.error('Giving up on a Discord notification', {
          attempts: attempt,
          reason: result.reason,
        });
        return false;
      }

      const waitMs = result.waitMs ?? this.backoffMs(attempt);
      log.warn('Retrying a Discord notification', { attempt, reason: result.reason, waitMs });
      await this.sleep(waitMs);
    }

    return false;
  }

  private async attempt(url: string, body: string): Promise<Attempt> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch (error) {
      // Usually nothing reached Discord. A response lost after Discord had
      // already accepted the post would duplicate the message on retry, and
      // that trade is taken deliberately: a repeated alert is a nuisance, a
      // missing one is the bug this exists to fix.
      return { done: false, reason: `network error: ${(error as Error).message}`, waitMs: null };
    }

    this.lastSentAt.set(url, this.now());
    // Undici keeps the connection allocated until the body is read, even when
    // Discord answers 204 with nothing in it.
    const text = await response.text().catch(() => '');

    if (response.ok) return { done: true, ok: true };

    if (response.status === 429) {
      const waitMs = retryAfterMs(response, text);
      return { done: false, reason: 'rate limited by discord', waitMs };
    }

    if (response.status >= 500) {
      return { done: false, reason: `discord returned ${response.status}`, waitMs: null };
    }

    // Any other 4xx is a verdict on the payload, and repeating it would only
    // spend attempts on a message Discord will never accept.
    log.error('Discord refused a notification; not retrying', {
      status: response.status,
      detail: text.slice(0, 200),
    });
    return { done: true, ok: false };
  }

  /** Holds a post back until the channel's last one is far enough behind. */
  private async pace(url: string): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const last = this.lastSentAt.get(url);
    if (last === undefined) return;

    const wait = last + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  private backoffMs(attempt: number): number {
    return Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  }
}
