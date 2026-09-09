import { log } from '../logger.js';
import type { ApiEnvelope } from './types.js';

export const BASE_URL = 'https://api.alphabot.app/v1/';
export const GET_BUDGET_PER_HOUR = 28;
const HOUR_MS = 3_600_000;

export class AuthError extends Error {}
export class BudgetExhaustedError extends Error {}

export class RateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
  }
}

export class ApiError extends Error {
  /**
   * @param declined True when Alphabot processed the request and refused it,
   * so nothing was created. False when the outcome is unknown — a 5xx, or
   * retries exhausted — which callers must not treat as safe to repeat.
   * @param data The envelope's `data` when there was one. A refusal still
   * carries a `validation` object naming the machine-readable reason, which
   * is far more useful than the English sentence in `errors`.
   */
  constructor(
    message: string,
    readonly status: number,
    readonly declined = false,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Sliding-window limiter: at most `capacity` takes per `windowMs`. */
export class TokenBucket {
  private readonly takes: number[] = [];

  constructor(private readonly capacity: number, private readonly windowMs: number) {}

  private prune(now: number): void {
    while (this.takes.length > 0 && now - (this.takes[0] as number) >= this.windowMs) {
      this.takes.shift();
    }
  }

  tryTake(now: number = Date.now()): boolean {
    this.prune(now);
    if (this.takes.length >= this.capacity) return false;
    this.takes.push(now);
    return true;
  }

  get available(): number {
    this.prune(Date.now());
    return Math.max(0, this.capacity - this.takes.length);
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  getBucket?: TokenBucket;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

type Query = Record<string, string | number | undefined>;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AlphabotClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly bucket: TokenBucket;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.bucket = opts.getBucket ?? new TokenBucket(GET_BUDGET_PER_HOUR, HOUR_MS);
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  get budgetRemaining(): number {
    return this.bucket.available;
  }

  async get<T>(path: string, query: Query = {}): Promise<T> {
    if (!this.bucket.tryTake()) {
      throw new BudgetExhaustedError(
        'Hourly Alphabot GET budget spent; skipping this request to stay under the 30/hour limit',
      );
    }
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.request<T>(url.toString(), { method: 'GET' });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl).toString();
    return this.request<T>(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${this.apiKey}`,
            accept: 'application/json',
          },
        });
      } catch (cause) {
        lastError = cause;
        if (attempt === this.maxRetries) break;
        await this.backoff(attempt);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new AuthError(
          'Alphabot rejected the API key (401/403). Check ALPHABOT_API_KEY and that the subscription is active.',
        );
      }

      if (response.status === 429) {
        const retryAfterMs = this.retryAfterMs(response);
        lastError = new RateLimitError('Alphabot rate limit hit', retryAfterMs);
        log.warn('Rate limited by Alphabot, backing off', { retryAfterMs, attempt });
        if (attempt === this.maxRetries) break;
        await this.sleep(retryAfterMs);
        continue;
      }

      if (response.status >= 500) {
        lastError = new ApiError(`Alphabot server error ${response.status}`, response.status);
        if (attempt === this.maxRetries) break;
        await this.backoff(attempt);
        continue;
      }

      const envelope = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;

      if (!response.ok || envelope?.success === false) {
        const detail = envelope?.errors?.map((e) => e.message).filter(Boolean).join('; ');
        // Alphabot answers a refused registration with HTTP 200 and
        // `success: false`, not a 4xx, so the envelope is what marks a
        // decision rather than the status code.
        throw new ApiError(
          detail
            ? `Alphabot request failed: ${detail}`
            : `Alphabot request failed (${response.status})`,
          response.status,
          true,
          envelope?.data,
        );
      }

      return envelope?.data as T;
    }

    throw lastError instanceof Error
      ? lastError
      : new ApiError('Alphabot request failed after retries', 0);
  }

  private retryAfterMs(response: Response): number {
    const header = response.headers.get('retry-after');
    const seconds = header ? Number(header) : NaN;
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000;
  }

  private async backoff(attempt: number): Promise<void> {
    const base = 500 * 2 ** attempt;
    await this.sleep(base + Math.floor(Math.random() * 250));
  }
}
