# Alphabot Auto Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript bot that receives Alphabot `raffle:active` webhooks, decides whether the owner qualifies, and automatically registers entries — deployed on Railway.

**Architecture:** A single Node HTTP service. Alphabot webhooks are the primary trigger (they carry full raffle requirements at zero rate-limit cost); a 10-minute poller is a downtime safety net. Both producers feed one serial entry queue that filters, registers, records, and notifies. Discord guild membership is read through OAuth2 so Discord-gated raffles can be matched to servers the owner actually joined.

**Tech Stack:** Node 22+, TypeScript (ESM, `nodenext`), native `fetch`, `node:http`, `zod`, `dotenv`, `vitest`, Docker, Railway.

**Spec:** `docs/superpowers/specs/2026-09-09-alphabot-auto-entry-design.md`

## Global Constraints

- Base URL is `https://api.alphabot.app/v1/`; auth header is `Authorization: Bearer <ALPHABOT_API_KEY>`.
- `GET /raffles` and `GET /raffles/{slug}` share a budget of **30 requests per hour**. The client's token bucket caps usable GETs at **28 per rolling hour**.
- `POST /register` allows 100 requests per minute; the queue paces at one per `entry.delayMs` (default 700 ms).
- Webhook hash is hex `HMAC_SHA256(ALPHABOT_API_KEY, event + "\n" + timestamp)`.
- **Every** webhook request must be answered `200`, including invalid ones. Work happens after the response.
- Secrets come only from environment variables. Never write a secret into `config.json`, a log line, or a test fixture.
- Never read Discord data with a user token / self-bot. OAuth2 (`identify guilds`) only.
- Every file stays under 300 lines. Every exported function gets a test.
- All tests mock `fetch`. No test performs real network I/O.
- Use ESM `import` syntax with explicit `.js` extensions on relative imports (required by `nodenext`).

---

### Task 1: Project scaffolding, config, and logger

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `config.json`
- Create: `src/config.ts`, `src/logger.ts`
- Test: `tests/config.test.ts`, `tests/logger.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadConfig(opts?: { configPath?: string; env?: Record<string, string | undefined> }): AppConfig`
  - `type AppConfig` with fields `poll`, `entry`, `discord`, `submission`, `env`
  - `registerSecret(value: string | null | undefined): void`
  - `redact(text: string): string`
  - `log.info/warn/error/debug(message: string, meta?: unknown): void`

- [ ] **Step 1: Create the project files**

`package.json`:

```json
{
  "name": "alphabot-auto-entry",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "dev": "node --watch --experimental-strip-types src/index.ts",
    "test": "vitest run",
    "test:cov": "vitest run --coverage",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.5",
    "@vitest/coverage-v8": "^2.1.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.2"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "skipLibCheck": true,
    "sourceMap": true,
    "declaration": false,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
```

`.gitignore`:

```gitignore
node_modules/
dist/
data/
.env
*.log
coverage/
```

`.env.example`:

```dotenv
# Alphabot API key (also the webhook HMAC secret). Required.
ALPHABOT_API_KEY=

# Public HTTPS base URL of this service, e.g. https://alphabot.up.railway.app
PUBLIC_BASE_URL=

# Where entered.json and discord tokens live. Railway volume mount path.
DATA_DIR=./data

# Discord application credentials (https://discord.com/developers/applications)
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=

# Discord channel webhook that receives bot notifications
DISCORD_NOTIFY_WEBHOOK_URL=

# Optional: comma separated guild ids, merged with the OAuth-derived list
DISCORD_GUILD_IDS=

# Optional: answer for password gated raffles
RAFFLE_PASSWORD=

# Injected by Railway; only set this locally
PORT=3000
```

`config.json`:

```json
{
  "poll": { "enabled": true, "intervalSeconds": 600, "pageSize": 50 },
  "entry": {
    "delayMs": 700,
    "dryRun": false,
    "skipCaptcha": true,
    "skipNftHolding": true,
    "skipTokenGated": true,
    "allowedBlockchains": [],
    "excludeKeywords": [],
    "minWinnerCount": 0
  },
  "discord": { "requireGuildWhitelist": true, "guildIds": [], "refreshHours": 6 },
  "submission": { "mintAddress": null, "discordId": null, "twitterId": null, "telegramId": null }
}
```

Then run `npm install`.

- [ ] **Step 2: Write the failing config test**

`tests/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

function writeConfig(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'abcfg-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
}

const VALID = {
  poll: { enabled: true, intervalSeconds: 600, pageSize: 50 },
  entry: {
    delayMs: 700, dryRun: false, skipCaptcha: true, skipNftHolding: true,
    skipTokenGated: true, allowedBlockchains: [], excludeKeywords: [], minWinnerCount: 0,
  },
  discord: { requireGuildWhitelist: true, guildIds: [], refreshHours: 6 },
  submission: { mintAddress: null, discordId: null, twitterId: null, telegramId: null },
};

describe('loadConfig', () => {
  it('loads a valid config with required env', () => {
    const cfg = loadConfig({
      configPath: writeConfig(VALID),
      env: { ALPHABOT_API_KEY: 'key-123' },
    });
    expect(cfg.env.alphabotApiKey).toBe('key-123');
    expect(cfg.poll.intervalSeconds).toBe(600);
    expect(cfg.env.dataDir).toBe('./data');
    expect(cfg.env.port).toBe(3000);
  });

  it('throws when ALPHABOT_API_KEY is missing', () => {
    expect(() => loadConfig({ configPath: writeConfig(VALID), env: {} }))
      .toThrow(/ALPHABOT_API_KEY/);
  });

  it('rejects a poll interval that would exhaust the GET budget', () => {
    const bad = { ...VALID, poll: { ...VALID.poll, intervalSeconds: 30 } };
    expect(() => loadConfig({ configPath: writeConfig(bad), env: { ALPHABOT_API_KEY: 'k' } }))
      .toThrow(/intervalSeconds/);
  });

  it('merges DISCORD_GUILD_IDS from env into config guildIds', () => {
    const withIds = { ...VALID, discord: { ...VALID.discord, guildIds: ['111'] } };
    const cfg = loadConfig({
      configPath: writeConfig(withIds),
      env: { ALPHABOT_API_KEY: 'k', DISCORD_GUILD_IDS: '222, 333 ,222' },
    });
    expect(cfg.discord.guildIds).toEqual(['111', '222', '333']);
  });

  it('strips a trailing slash from PUBLIC_BASE_URL', () => {
    const cfg = loadConfig({
      configPath: writeConfig(VALID),
      env: { ALPHABOT_API_KEY: 'k', PUBLIC_BASE_URL: 'https://x.up.railway.app/' },
    });
    expect(cfg.env.publicBaseUrl).toBe('https://x.up.railway.app');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 4: Implement `src/config.ts`**

```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const MIN_POLL_SECONDS = 120;

const fileSchema = z.object({
  poll: z.object({
    enabled: z.boolean(),
    intervalSeconds: z.number().int().min(MIN_POLL_SECONDS,
      `poll.intervalSeconds must be >= ${MIN_POLL_SECONDS} to stay inside the 30 GET/hour limit`),
    pageSize: z.number().int().min(1).max(50),
  }),
  entry: z.object({
    delayMs: z.number().int().min(100),
    dryRun: z.boolean(),
    skipCaptcha: z.boolean(),
    skipNftHolding: z.boolean(),
    skipTokenGated: z.boolean(),
    allowedBlockchains: z.array(z.string()),
    excludeKeywords: z.array(z.string()),
    minWinnerCount: z.number().int().min(0),
  }),
  discord: z.object({
    requireGuildWhitelist: z.boolean(),
    guildIds: z.array(z.string()),
    refreshHours: z.number().int().min(1).max(168),
  }),
  submission: z.object({
    mintAddress: z.string().nullable(),
    discordId: z.string().nullable(),
    twitterId: z.string().nullable(),
    telegramId: z.string().nullable(),
  }),
});

export type FileConfig = z.infer<typeof fileSchema>;

export interface EnvConfig {
  alphabotApiKey: string;
  port: number;
  dataDir: string;
  publicBaseUrl: string | null;
  discordClientId: string | null;
  discordClientSecret: string | null;
  notifyWebhookUrl: string | null;
  rafflePassword: string | null;
}

export interface AppConfig extends FileConfig {
  env: EnvConfig;
}

export interface LoadOptions {
  configPath?: string;
  env?: Record<string, string | undefined>;
}

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function loadConfig(opts: LoadOptions = {}): AppConfig {
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? 'config.json';

  const apiKey = optional(env.ALPHABOT_API_KEY);
  if (!apiKey) {
    throw new Error('ALPHABOT_API_KEY is required. Set it in .env or in Railway variables.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (cause) {
    throw new Error(`Could not read config file at ${configPath}`, { cause });
  }

  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid ${configPath} - ${detail}`);
  }

  const file = parsed.data;

  const envGuildIds = (env.DISCORD_GUILD_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const guildIds = [...new Set([...file.discord.guildIds, ...envGuildIds])];

  const baseUrl = optional(env.PUBLIC_BASE_URL);

  return Object.freeze({
    ...file,
    discord: { ...file.discord, guildIds },
    env: {
      alphabotApiKey: apiKey,
      port: Number(env.PORT ?? 3000),
      dataDir: optional(env.DATA_DIR) ?? './data',
      publicBaseUrl: baseUrl ? baseUrl.replace(/\/+$/, '') : null,
      discordClientId: optional(env.DISCORD_CLIENT_ID),
      discordClientSecret: optional(env.DISCORD_CLIENT_SECRET),
      notifyWebhookUrl: optional(env.DISCORD_NOTIFY_WEBHOOK_URL),
      rafflePassword: optional(env.RAFFLE_PASSWORD),
    },
  });
}
```

- [ ] **Step 5: Run the config test — expect PASS**

Run: `npx vitest run tests/config.test.ts`

- [ ] **Step 6: Write the failing logger test**

`tests/logger.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { log, redact, registerSecret } from '../src/logger.js';

afterEach(() => vi.restoreAllMocks());

describe('redact', () => {
  it('masks registered secrets anywhere in the text', () => {
    registerSecret('super-secret-key');
    expect(redact('token=super-secret-key done')).toBe('token=[REDACTED] done');
  });

  it('ignores empty or null secrets', () => {
    registerSecret(null);
    registerSecret('');
    expect(redact('nothing to hide')).toBe('nothing to hide');
  });
});

describe('log', () => {
  it('writes a level, a timestamp and the message', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.info('hello');
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/INFO.*hello/);
  });

  it('redacts secrets in the message and the metadata', () => {
    registerSecret('abc123xyz');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.error('key abc123xyz failed', { key: 'abc123xyz' });
    const line = spy.mock.calls[0]?.join(' ') ?? '';
    expect(line).not.toContain('abc123xyz');
    expect(line).toContain('[REDACTED]');
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run tests/logger.test.ts`
Expected: FAIL — cannot resolve `../src/logger.js`.

- [ ] **Step 8: Implement `src/logger.ts`**

```ts
const secrets = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
  return out;
}

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

function emit(level: Level, message: string, meta?: unknown): void {
  const line = `${new Date().toISOString()} ${level} ${redact(message)}`;
  const extra = meta === undefined ? undefined : redact(JSON.stringify(meta));
  const sink = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
}

export const log = {
  debug: (m: string, meta?: unknown) => emit('DEBUG', m, meta),
  info: (m: string, meta?: unknown) => emit('INFO', m, meta),
  warn: (m: string, meta?: unknown) => emit('WARN', m, meta),
  error: (m: string, meta?: unknown) => emit('ERROR', m, meta),
};
```

- [ ] **Step 9: Run the whole suite — expect PASS**

Run: `npx vitest run` then `npx tsc --noEmit`

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore .env.example config.json src/config.ts src/logger.ts tests/config.test.ts tests/logger.test.ts
git commit -m "feat: project scaffolding, validated config and redacting logger"
```

---

### Task 2: API types and rate-limited HTTP client

**Files:**
- Create: `src/api/types.ts`, `src/api/client.ts`
- Test: `tests/api/client.test.ts`

**Interfaces:**
- Consumes: `log` from `src/logger.js`.
- Produces:
  - `type RaffleForList`, `type RaffleRequirements`, `type RaffleWithRequirements`, `type DiscordServerRole`, `type ValidationResult`, `type RegisterResponse`, `type ApiEnvelope<T>`, `type WebhookBody`
  - `class TokenBucket { constructor(capacity: number, windowMs: number); tryTake(now?: number): boolean; get available(): number }`
  - `class AlphabotClient { constructor(opts: ClientOptions); get<T>(path, query?): Promise<T>; post<T>(path, body): Promise<T>; get budgetRemaining(): number }`
  - `class AuthError`, `class RateLimitError`, `class ApiError`, `class BudgetExhaustedError`

- [ ] **Step 1: Write `src/api/types.ts`**

```ts
export type ReqLetter = 'n' | 'd' | 'r' | 'f' | 'l' | 't' | 'g';

export interface RaffleForList {
  _id: string;
  slug: string;
  name: string;
  type?: string;
  status: string;
  visibility?: string;
  description?: string;
  startDate?: number;
  endDate?: number;
  winnerCount?: number;
  bannerImageUrl?: string;
  blockchain?: string;
  twitterUrl?: string;
  discordUrl?: string;
  entryCount?: number;
  reqString?: string;
  projectId?: string;
  teamId?: string;
  dtc?: boolean;
}

export interface DiscordRoleRequirement {
  roleId?: string;
  val?: number;
  name?: string;
  stacking?: boolean;
}

export interface DiscordServerRole {
  id: string;
  label?: string;
  inviteLink?: string;
  exclude?: boolean;
  roles?: DiscordRoleRequirement[];
}

export interface RaffleRequirements {
  requirePremium?: boolean;
  connectDiscord?: boolean;
  connectTwitter?: boolean;
  connectWallet?: boolean;
  connectEmail?: boolean;
  connectTelegram?: boolean;
  connectPassword?: boolean;
  connectCaptcha?: boolean;
  signWallet?: boolean;
  excludePreviousWinners?: boolean;
  requiredEth?: number;
  requiredTokens?: unknown[];
  discordServerRoles?: DiscordServerRole[];
  twitterFollows?: { id?: string; name?: string; image?: string }[];
  twitterRetweet?: string;
  twitterRetweetType?: string;
}

export type RaffleWithRequirements = RaffleForList & RaffleRequirements;

export interface ValidationResult {
  entries?: number;
  success?: boolean;
  reason?: string;
  discordValid?: boolean;
  twitterValid?: boolean;
  tokensValid?: boolean;
  emailValid?: boolean;
  ethBalanceValid?: boolean;
  questionsValid?: boolean;
  passwordInvalid?: boolean;
}

export interface RegisterResponse {
  resultMd?: string;
  validation?: ValidationResult;
  pendingCheck?: { start?: number; complete?: number };
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  errors?: { message?: string; code?: string }[];
}

export interface RafflesListData {
  raffles: RaffleForList[];
  finalPage?: boolean;
}

export interface RaffleEntry {
  slug?: string;
  mintAddress?: string;
  discordName?: string;
  twitterName?: string;
  entries?: number;
  winner?: boolean;
}

export interface WebhookBody {
  event: string;
  timestamp: number;
  hash: string;
  data?: {
    raffle?: RaffleWithRequirements;
    entry?: RaffleEntry;
    user?: { _id?: string; address?: string };
  };
}
```

- [ ] **Step 2: Write the failing client test**

`tests/api/client.test.ts`:

```ts
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

function makeClient(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new AlphabotClient({
    apiKey: 'test-key',
    fetchImpl,
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
    const bucket = new TokenBucket(2, 1000);
    bucket.tryTake(0);
    expect(bucket.available).toBe(1);
  });
});

describe('AlphabotClient', () => {
  it('sends the bearer token and unwraps the data envelope', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: { ok: 1 } }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.get<{ ok: number }>('raffles', { status: 'active' });

    expect(result).toEqual({ ok: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.alphabot.app/v1/raffles?status=active');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
  });

  it('omits undefined query values', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: {} }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.get('raffles', { status: 'active', pageNum: undefined });
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
      'https://api.alphabot.app/v1/raffles?status=active',
    );
  });

  it('throws AuthError on 401 without retrying', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: false }, 401));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('raffles')).rejects.toBeInstanceOf(AuthError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries a 500 and succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: false }, 500))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: true } }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('raffles')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honours Retry-After on 429 and retries', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: false }, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: 'ok' }));
    const client = makeClient(fetchImpl as unknown as typeof fetch, { sleep });
    await expect(client.get('raffles')).resolves.toBe('ok');
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('throws ApiError with the server message on 400', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: false, errors: [{ message: 'bad slug' }] }, 400));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.post('register', { slug: 'x' })).rejects.toThrow(/bad slug/);
    await expect(client.post('register', { slug: 'x' })).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a GET once the hourly budget is spent', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: 1 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      getBucket: new TokenBucket(1, 3_600_000),
    });
    await client.get('raffles');
    await expect(client.get('raffles')).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not spend GET budget on POST', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: 1 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      getBucket: new TokenBucket(1, 3_600_000),
    });
    await client.post('register', {});
    await client.post('register', {});
    expect(client.budgetRemaining).toBe(1);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/api/client.test.ts`
Expected: FAIL — cannot resolve `../../src/api/client.js`.

- [ ] **Step 4: Implement `src/api/client.ts`**

```ts
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
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

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

      const envelope = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;

      if (response.status >= 500) {
        lastError = new ApiError(`Alphabot server error ${response.status}`, response.status);
        if (attempt === this.maxRetries) break;
        await this.backoff(attempt);
        continue;
      }

      if (!response.ok || envelope?.success === false) {
        const detail = envelope?.errors?.map((e) => e.message).filter(Boolean).join('; ');
        throw new ApiError(
          detail ? `Alphabot request failed: ${detail}` : `Alphabot request failed (${response.status})`,
          response.status,
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
```

- [ ] **Step 5: Run the test — expect PASS**

Run: `npx vitest run tests/api/client.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/api/types.ts src/api/client.ts tests/api/client.test.ts
git commit -m "feat: alphabot api types and rate-limited http client"
```

---

### Task 3: Raffles API surface

**Files:**
- Create: `src/api/raffles.ts`
- Test: `tests/api/raffles.test.ts`

**Interfaces:**
- Consumes: `AlphabotClient` from `src/api/client.js`; types from `src/api/types.js`.
- Produces:
  - `listActiveRaffles(client: AlphabotClient, opts?: { pageSize?: number; pageNum?: number }): Promise<RaffleForList[]>`
  - `interface RegisterInput { slug: string; mintAddress?: string; discordId?: string; twitterId?: string; telegramId?: string }`
  - `interface RegisterOutcome { success: boolean; entries: number | null; reason: string | null; resultMd: string | null }`
  - `register(client: AlphabotClient, input: RegisterInput): Promise<RegisterOutcome>`

- [ ] **Step 1: Write the failing test**

`tests/api/raffles.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { listActiveRaffles, register } from '../../src/api/raffles.js';
import type { AlphabotClient } from '../../src/api/client.js';

function fakeClient(over: Partial<AlphabotClient>): AlphabotClient {
  return { get: vi.fn(), post: vi.fn(), budgetRemaining: 28, ...over } as unknown as AlphabotClient;
}

describe('listActiveRaffles', () => {
  it('requests active unregistered raffles sorted by ending soonest', async () => {
    const get = vi.fn(async () => ({ raffles: [{ slug: 'a' }], finalPage: true }));
    const client = fakeClient({ get });

    const raffles = await listActiveRaffles(client, { pageSize: 50 });

    expect(raffles).toEqual([{ slug: 'a' }]);
    expect(get).toHaveBeenCalledWith('raffles', {
      status: 'active',
      filter: 'unregistered',
      sort: 'ending',
      sortDir: 1,
      pageSize: 50,
      pageNum: 0,
    });
  });

  it('returns an empty array when the API returns no data', async () => {
    const client = fakeClient({ get: vi.fn(async () => undefined) });
    await expect(listActiveRaffles(client)).resolves.toEqual([]);
  });
});

describe('register', () => {
  it('omits undefined submission fields', async () => {
    const post = vi.fn(async () => ({ validation: { success: true, entries: 3 } }));
    const client = fakeClient({ post });

    const outcome = await register(client, { slug: 'cool-raffle', discordId: '42' });

    expect(post).toHaveBeenCalledWith('register', { slug: 'cool-raffle', discordId: '42' });
    expect(outcome).toEqual({ success: true, entries: 3, reason: null, resultMd: null });
  });

  it('surfaces the failure reason from validation', async () => {
    const post = vi.fn(async () => ({
      resultMd: 'You are not in the server',
      validation: { success: false, reason: 'discord_invalid' },
    }));
    const outcome = await register(fakeClient({ post }), { slug: 's' });
    expect(outcome.success).toBe(false);
    expect(outcome.reason).toBe('discord_invalid');
    expect(outcome.resultMd).toBe('You are not in the server');
  });

  it('treats a missing validation block as success when the call resolved', async () => {
    const post = vi.fn(async () => ({ resultMd: 'Entered!' }));
    const outcome = await register(fakeClient({ post }), { slug: 's' });
    expect(outcome.success).toBe(true);
    expect(outcome.entries).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/api/raffles.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/api/raffles.ts`**

```ts
import type { AlphabotClient } from './client.js';
import type { RafflesListData, RaffleForList, RegisterResponse } from './types.js';

export interface ListOptions {
  pageSize?: number;
  pageNum?: number;
}

export async function listActiveRaffles(
  client: AlphabotClient,
  opts: ListOptions = {},
): Promise<RaffleForList[]> {
  const data = await client.get<RafflesListData | undefined>('raffles', {
    status: 'active',
    filter: 'unregistered',
    sort: 'ending',
    sortDir: 1,
    pageSize: opts.pageSize ?? 50,
    pageNum: opts.pageNum ?? 0,
  });
  return data?.raffles ?? [];
}

export interface RegisterInput {
  slug: string;
  mintAddress?: string;
  discordId?: string;
  twitterId?: string;
  telegramId?: string;
}

export interface RegisterOutcome {
  success: boolean;
  entries: number | null;
  reason: string | null;
  resultMd: string | null;
}

export async function register(
  client: AlphabotClient,
  input: RegisterInput,
): Promise<RegisterOutcome> {
  const body: Record<string, string> = { slug: input.slug };
  for (const key of ['mintAddress', 'discordId', 'twitterId', 'telegramId'] as const) {
    const value = input[key];
    if (value !== undefined && value !== null) body[key] = value;
  }

  const data = await client.post<RegisterResponse | undefined>('register', body);
  const validation = data?.validation;

  return {
    success: validation?.success ?? true,
    entries: validation?.entries ?? null,
    reason: validation?.reason ?? null,
    resultMd: data?.resultMd ?? null,
  };
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run tests/api/raffles.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/api/raffles.ts tests/api/raffles.test.ts
git commit -m "feat: raffles list and register api calls"
```

---

### Task 4: Webhook signature verification

**Files:**
- Create: `src/webhook/verify.ts`
- Test: `tests/webhook/verify.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `computeHash(event: string, timestamp: number, apiKey: string): string`
  - `verifyWebhook(body: unknown, apiKey: string): body is WebhookBody`

- [ ] **Step 1: Write the failing test**

`tests/webhook/verify.test.ts`:

```ts
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

  it('rejects a hash of the wrong length without throwing', () => {
    const body = signed('raffle:active', 1234);
    expect(verifyWebhook({ ...body, hash: 'abc' }, KEY)).toBe(false);
  });

  it.each([
    null,
    undefined,
    'string',
    {},
    { event: 'x', timestamp: 1 },
    { event: 'x', hash: 'y' },
    { event: 1, timestamp: 1, hash: 'y' },
  ])('rejects malformed body %#', (body) => {
    expect(verifyWebhook(body, KEY)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/webhook/verify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/webhook/verify.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookBody } from '../api/types.js';

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
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run tests/webhook/verify.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/webhook/verify.ts tests/webhook/verify.test.ts
git commit -m "feat: timing-safe alphabot webhook signature verification"
```

---

### Task 5: Durable entry store

**Files:**
- Create: `src/core/store.ts`
- Test: `tests/core/store.test.ts`

**Interfaces:**
- Consumes: `log` from `src/logger.js`.
- Produces:
  - `interface EntryRecord { slug: string; name: string; at: number; success: boolean; entries: number | null; reason: string | null }`
  - `class EntryStore { static open(dataDir: string): Promise<EntryStore>; has(slug: string): boolean; get(slug: string): EntryRecord | undefined; record(rec: EntryRecord): Promise<void>; get size(): number }`

- [ ] **Step 1: Write the failing test**

`tests/core/store.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EntryStore } from '../../src/core/store.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'abstore-'));

const rec = (slug: string) => ({
  slug, name: `Raffle ${slug}`, at: 1000, success: true, entries: 2, reason: null,
});

describe('EntryStore', () => {
  it('starts empty when the file does not exist', async () => {
    const store = await EntryStore.open(join(tempDir(), 'nested'));
    expect(store.size).toBe(0);
    expect(store.has('anything')).toBe(false);
  });

  it('records and reads back an entry', async () => {
    const dir = tempDir();
    const store = await EntryStore.open(dir);
    await store.record(rec('cool-raffle'));
    expect(store.has('cool-raffle')).toBe(true);
    expect(store.get('cool-raffle')?.entries).toBe(2);
  });

  it('persists across reopen', async () => {
    const dir = tempDir();
    const first = await EntryStore.open(dir);
    await first.record(rec('persisted'));
    const second = await EntryStore.open(dir);
    expect(second.has('persisted')).toBe(true);
  });

  it('writes valid json to entered.json', async () => {
    const dir = tempDir();
    const store = await EntryStore.open(dir);
    await store.record(rec('x'));
    const raw = JSON.parse(readFileSync(join(dir, 'entered.json'), 'utf8'));
    expect(raw.x.slug).toBe('x');
  });

  it('recovers from a corrupted file instead of crashing', async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'entered.json'), '{not json');
    const store = await EntryStore.open(dir);
    expect(store.size).toBe(0);
    await store.record(rec('after-corruption'));
    expect(store.has('after-corruption')).toBe(true);
  });

  it('keeps the in-memory record when the disk write fails', async () => {
    const dir = tempDir();
    const store = await EntryStore.open(dir);
    const spy = vi.spyOn(store as unknown as { persist: () => Promise<void> }, 'persist')
      .mockRejectedValue(new Error('disk full'));
    await expect(store.record(rec('resilient'))).resolves.toBeUndefined();
    expect(store.has('resilient')).toBe(true);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/core/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/store.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../logger.js';

export interface EntryRecord {
  slug: string;
  name: string;
  at: number;
  success: boolean;
  entries: number | null;
  reason: string | null;
}

const FILE_NAME = 'entered.json';

export class EntryStore {
  private constructor(
    private readonly filePath: string,
    private readonly records: Map<string, EntryRecord>,
  ) {}

  static async open(dataDir: string): Promise<EntryStore> {
    const filePath = join(dataDir, FILE_NAME);
    const records = new Map<string, EntryRecord>();

    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, EntryRecord>;
      for (const [slug, record] of Object.entries(parsed)) records.set(slug, record);
      log.info(`Loaded ${records.size} previously attempted raffles`, { filePath });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        log.warn('entered.json was unreadable and will be rebuilt', { filePath });
      }
    }

    return new EntryStore(filePath, records);
  }

  has(slug: string): boolean {
    return this.records.has(slug);
  }

  get(slug: string): EntryRecord | undefined {
    return this.records.get(slug);
  }

  get size(): number {
    return this.records.size;
  }

  async record(entry: EntryRecord): Promise<void> {
    this.records.set(entry.slug, entry);
    try {
      await this.persist();
    } catch (error) {
      log.warn('Could not persist entered.json; continuing from memory', {
        message: (error as Error).message,
      });
    }
  }

  private async persist(): Promise<void> {
    const dir = join(this.filePath, '..');
    await mkdir(dir, { recursive: true });
    const payload = JSON.stringify(Object.fromEntries(this.records), null, 2);
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, payload, 'utf8');
    await rename(tmpPath, this.filePath);
  }
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run tests/core/store.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/store.ts tests/core/store.test.ts
git commit -m "feat: durable entry store with atomic writes"
```

---

### Task 6: Eligibility filter

This is the heart of the bot. It is a pure function so every rule in the spec gets a direct test.

**Files:**
- Create: `src/core/filter.ts`
- Test: `tests/core/filter.test.ts`

**Interfaces:**
- Consumes: `AppConfig` from `src/config.js`; `RaffleWithRequirements` from `src/api/types.js`.
- Produces:
  - `type SkipReason` — the union listed in the implementation below
  - `interface FilterContext { config: AppConfig; knownGuildIds: ReadonlySet<string>; isEntered(slug: string): boolean; hasPassword: boolean; fromWebhook: boolean; now?: number }`
  - `type FilterResult = { eligible: true } | { eligible: false; reason: SkipReason }`
  - `evaluate(raffle: RaffleWithRequirements, ctx: FilterContext): FilterResult`

- [ ] **Step 1: Write the failing test**

`tests/core/filter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluate, type FilterContext } from '../../src/core/filter.js';
import type { AppConfig } from '../../src/config.js';
import type { RaffleWithRequirements } from '../../src/api/types.js';

const NOW = 1_700_000_000_000;

const config = (over: Partial<AppConfig['entry']> = {}, discordOver: Partial<AppConfig['discord']> = {}) => ({
  poll: { enabled: true, intervalSeconds: 600, pageSize: 50 },
  entry: {
    delayMs: 700, dryRun: false, skipCaptcha: true, skipNftHolding: true,
    skipTokenGated: true, allowedBlockchains: [], excludeKeywords: [], minWinnerCount: 0,
    ...over,
  },
  discord: { requireGuildWhitelist: true, guildIds: [], refreshHours: 6, ...discordOver },
  submission: { mintAddress: null, discordId: null, twitterId: null, telegramId: null },
  env: {} as AppConfig['env'],
}) as AppConfig;

const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({
  config: config(),
  knownGuildIds: new Set(['guild-a']),
  isEntered: () => false,
  hasPassword: false,
  fromWebhook: true,
  now: NOW,
  ...over,
});

const raffle = (over: Partial<RaffleWithRequirements> = {}): RaffleWithRequirements => ({
  _id: '1',
  slug: 'test-raffle',
  name: 'Test Raffle',
  status: 'active',
  endDate: NOW + 60_000,
  winnerCount: 10,
  ...over,
});

const reasonOf = (r: ReturnType<typeof evaluate>) => (r.eligible ? null : r.reason);

describe('evaluate', () => {
  it('accepts a plain active raffle with no requirements', () => {
    expect(evaluate(raffle(), ctx())).toEqual({ eligible: true });
  });

  it('skips a raffle that is not active', () => {
    expect(reasonOf(evaluate(raffle({ status: 'ended' }), ctx()))).toBe('not_active');
  });

  it('skips a raffle whose endDate has passed', () => {
    expect(reasonOf(evaluate(raffle({ endDate: NOW - 1 }), ctx()))).toBe('ended');
  });

  it('skips a raffle already in the store', () => {
    const result = evaluate(raffle(), ctx({ isEntered: () => true }));
    expect(reasonOf(result)).toBe('already_entered');
  });

  it('skips captcha gated raffles', () => {
    expect(reasonOf(evaluate(raffle({ connectCaptcha: true }), ctx()))).toBe('captcha_required');
  });

  it('enters a captcha raffle when skipCaptcha is off', () => {
    const c = ctx({ config: config({ skipCaptcha: false }) });
    expect(evaluate(raffle({ connectCaptcha: true }), c).eligible).toBe(true);
  });

  it('skips password gated raffles when no password is configured', () => {
    expect(reasonOf(evaluate(raffle({ connectPassword: true }), ctx()))).toBe('password_required');
  });

  it('enters a password gated raffle when a password is configured', () => {
    const result = evaluate(raffle({ connectPassword: true }), ctx({ hasPassword: true }));
    expect(result.eligible).toBe(true);
  });

  it('skips token gated raffles', () => {
    const result = evaluate(raffle({ requiredTokens: [{ any: 'token' }] }), ctx());
    expect(reasonOf(result)).toBe('token_gated');
  });

  it('skips raffles requiring an eth balance', () => {
    expect(reasonOf(evaluate(raffle({ requiredEth: 0.5 }), ctx()))).toBe('eth_balance_required');
  });

  it('skips nft holding raffles based on reqString', () => {
    expect(reasonOf(evaluate(raffle({ reqString: 'nd' }), ctx()))).toBe('nft_holding_required');
  });

  it('enters a discord gated raffle when the guild is known', () => {
    const r = raffle({ discordServerRoles: [{ id: 'guild-a', label: 'Cool DAO' }] });
    expect(evaluate(r, ctx()).eligible).toBe(true);
  });

  it('skips a discord gated raffle for a guild that is not joined', () => {
    const r = raffle({ discordServerRoles: [{ id: 'guild-z' }] });
    expect(reasonOf(evaluate(r, ctx()))).toBe('discord_guild_not_joined');
  });

  it('ignores exclude-type discord entries when matching guilds', () => {
    const r = raffle({
      discordServerRoles: [{ id: 'guild-a' }, { id: 'guild-z', exclude: true }],
    });
    expect(evaluate(r, ctx()).eligible).toBe(true);
  });

  it('requires every non-exclude guild to be known', () => {
    const r = raffle({ discordServerRoles: [{ id: 'guild-a' }, { id: 'guild-b' }] });
    expect(reasonOf(evaluate(r, ctx()))).toBe('discord_guild_not_joined');
  });

  it('enters discord gated raffles when the whitelist is disabled', () => {
    const c = ctx({ config: config({}, { requireGuildWhitelist: false }) });
    const r = raffle({ discordServerRoles: [{ id: 'guild-z' }] });
    expect(evaluate(r, c).eligible).toBe(true);
  });

  it('skips poller raffles whose discord requirement cannot be resolved', () => {
    const r = raffle({ reqString: 'd' });
    expect(reasonOf(evaluate(r, ctx({ fromWebhook: false })))).toBe('discord_requirements_unknown');
  });

  it('does not apply the poller fallback to webhook raffles', () => {
    const r = raffle({ reqString: 'd', discordServerRoles: [{ id: 'guild-a' }] });
    expect(evaluate(r, ctx()).eligible).toBe(true);
  });

  it('skips blockchains outside the allow list', () => {
    const c = ctx({ config: config({ allowedBlockchains: ['ethereum'] }) });
    expect(reasonOf(evaluate(raffle({ blockchain: 'solana' }), c))).toBe('blockchain_excluded');
  });

  it('matches excluded keywords case-insensitively', () => {
    const c = ctx({ config: config({ excludeKeywords: ['TEST'] }) });
    expect(reasonOf(evaluate(raffle({ name: 'a test raffle' }), c))).toBe('keyword_excluded');
  });

  it('skips raffles with too few winners', () => {
    const c = ctx({ config: config({ minWinnerCount: 50 }) });
    expect(reasonOf(evaluate(raffle({ winnerCount: 10 }), c))).toBe('too_few_winners');
  });

  it('does not filter on twitter requirements', () => {
    const r = raffle({ reqString: 'flt', twitterFollows: [{ id: '1', name: 'x' }] });
    expect(evaluate(r, ctx()).eligible).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/core/filter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/filter.ts`**

```ts
import type { AppConfig } from '../config.js';
import type { RaffleWithRequirements } from '../api/types.js';

export type SkipReason =
  | 'not_active'
  | 'ended'
  | 'already_entered'
  | 'captcha_required'
  | 'password_required'
  | 'token_gated'
  | 'eth_balance_required'
  | 'nft_holding_required'
  | 'discord_guild_not_joined'
  | 'discord_requirements_unknown'
  | 'blockchain_excluded'
  | 'keyword_excluded'
  | 'too_few_winners';

export interface FilterContext {
  config: AppConfig;
  knownGuildIds: ReadonlySet<string>;
  isEntered: (slug: string) => boolean;
  hasPassword: boolean;
  /** Webhook payloads carry full requirements; poller payloads do not. */
  fromWebhook: boolean;
  now?: number;
}

export type FilterResult = { eligible: true } | { eligible: false; reason: SkipReason };

const skip = (reason: SkipReason): FilterResult => ({ eligible: false, reason });
const PASS: FilterResult = { eligible: true };

export function evaluate(raffle: RaffleWithRequirements, ctx: FilterContext): FilterResult {
  const { entry, discord } = ctx.config;
  const now = ctx.now ?? Date.now();

  if (raffle.status !== 'active') return skip('not_active');
  if (typeof raffle.endDate === 'number' && raffle.endDate <= now) return skip('ended');
  if (ctx.isEntered(raffle.slug)) return skip('already_entered');

  if (entry.skipCaptcha && raffle.connectCaptcha === true) return skip('captcha_required');
  if (raffle.connectPassword === true && !ctx.hasPassword) return skip('password_required');

  if (entry.skipTokenGated) {
    if ((raffle.requiredTokens?.length ?? 0) > 0) return skip('token_gated');
    if ((raffle.requiredEth ?? 0) > 0) return skip('eth_balance_required');
  }

  const reqString = raffle.reqString ?? '';
  if (entry.skipNftHolding && reqString.includes('n')) return skip('nft_holding_required');

  if (discord.requireGuildWhitelist) {
    const servers = raffle.discordServerRoles ?? [];
    if (servers.length > 0) {
      const required = servers.filter((s) => s.exclude !== true);
      const allKnown = required.every((s) => ctx.knownGuildIds.has(s.id));
      if (!allKnown) return skip('discord_guild_not_joined');
    } else if (!ctx.fromWebhook && (reqString.includes('d') || reqString.includes('r'))) {
      // The list endpoint does not expose which guild is required, and resolving it
      // would spend the scarce GET budget. Webhooks are the path for these raffles.
      return skip('discord_requirements_unknown');
    }
  }

  if (entry.allowedBlockchains.length > 0) {
    const chain = raffle.blockchain?.toLowerCase() ?? '';
    const allowed = entry.allowedBlockchains.map((c) => c.toLowerCase());
    if (!allowed.includes(chain)) return skip('blockchain_excluded');
  }

  if (entry.excludeKeywords.length > 0) {
    const name = raffle.name.toLowerCase();
    if (entry.excludeKeywords.some((k) => name.includes(k.toLowerCase()))) {
      return skip('keyword_excluded');
    }
  }

  if ((raffle.winnerCount ?? 0) < entry.minWinnerCount) return skip('too_few_winners');

  return PASS;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run tests/core/filter.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/filter.ts tests/core/filter.test.ts
git commit -m "feat: pure eligibility filter with discord guild matching"
```

---

### Task 7: Discord notifier

**Files:**
- Create: `src/notify/discord.ts`
- Test: `tests/notify/discord.test.ts`

**Interfaces:**
- Consumes: `log`; `RaffleForList`, `RaffleEntry` from `src/api/types.js`; `RegisterOutcome` from `src/api/raffles.js`; `SkipReason` from `src/core/filter.js`.
- Produces:
  - `class DiscordNotifier { constructor(webhookUrl: string | null, fetchImpl?: typeof fetch); entered(raffle, outcome): Promise<void>; failed(raffle, message): Promise<void>; skipped(raffle, reason): Promise<void>; won(raffle, entry): Promise<void>; fatal(message): Promise<void> }`

`skipped()` only logs — it never posts to Discord, because skips are the common case and would flood the channel.

- [ ] **Step 1: Write the failing test**

`tests/notify/discord.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { DiscordNotifier } from '../../src/notify/discord.js';
import type { RaffleForList } from '../../src/api/types.js';

const raffle = { _id: '1', slug: 'cool-raffle', name: 'Cool Raffle', status: 'active' } as RaffleForList;
const ok = () => new Response('', { status: 204 });

describe('DiscordNotifier', () => {
  it('posts an embed when a raffle is entered', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const notifier = new DiscordNotifier('https://discord.com/api/webhooks/x', fetchImpl as unknown as typeof fetch);

    await notifier.entered(raffle, { success: true, entries: 3, reason: null, resultMd: null });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/webhooks/x');
    const payload = JSON.parse(init.body as string);
    expect(payload.embeds[0].title).toContain('Cool Raffle');
    expect(payload.embeds[0].url).toBe('https://www.alphabot.app/cool-raffle');
    expect(JSON.stringify(payload)).toContain('3');
  });

  it('does nothing when no webhook url is configured', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const notifier = new DiscordNotifier(null, fetchImpl as unknown as typeof fetch);
    await notifier.entered(raffle, { success: true, entries: 1, reason: null, resultMd: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws when discord rejects the webhook', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const notifier = new DiscordNotifier('https://discord.com/api/webhooks/x', fetchImpl as unknown as typeof fetch);
    await expect(notifier.failed(raffle, 'boom')).resolves.toBeUndefined();
  });

  it('never throws when the network fails', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    const notifier = new DiscordNotifier('https://discord.com/api/webhooks/x', fetchImpl as unknown as typeof fetch);
    await expect(notifier.fatal('bad key')).resolves.toBeUndefined();
  });

  it('does not post for skips', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const notifier = new DiscordNotifier('https://discord.com/api/webhooks/x', fetchImpl as unknown as typeof fetch);
    await notifier.skipped(raffle, 'captcha_required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts a win notification', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const notifier = new DiscordNotifier('https://discord.com/api/webhooks/x', fetchImpl as unknown as typeof fetch);
    await notifier.won(raffle, { mintAddress: '0xabc' });
    const payload = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(JSON.stringify(payload)).toContain('0xabc');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/notify/discord.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/notify/discord.ts`**

```ts
import { log } from '../logger.js';
import type { RaffleEntry, RaffleForList } from '../api/types.js';
import type { RegisterOutcome } from '../api/raffles.js';
import type { SkipReason } from '../core/filter.js';

const COLOR_SUCCESS = 0x2ecc71;
const COLOR_FAILURE = 0xe67e22;
const COLOR_WIN = 0xf1c40f;
const COLOR_FATAL = 0xe74c3c;

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface Embed {
  title: string;
  url?: string;
  description?: string;
  color: number;
  fields?: EmbedField[];
  timestamp: string;
}

const raffleUrl = (slug: string) => `https://www.alphabot.app/${slug}`;

export class DiscordNotifier {
  constructor(
    private readonly webhookUrl: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async entered(raffle: RaffleForList, outcome: RegisterOutcome): Promise<void> {
    const fields: EmbedField[] = [];
    if (outcome.entries !== null) {
      fields.push({ name: 'Entries', value: String(outcome.entries), inline: true });
    }
    if (raffle.winnerCount !== undefined) {
      fields.push({ name: 'Winners', value: String(raffle.winnerCount), inline: true });
    }
    if (raffle.blockchain) {
      fields.push({ name: 'Chain', value: raffle.blockchain, inline: true });
    }

    await this.send({
      title: `Entered: ${raffle.name}`,
      url: raffleUrl(raffle.slug),
      color: COLOR_SUCCESS,
      fields,
      timestamp: new Date().toISOString(),
    });
  }

  async failed(raffle: RaffleForList, message: string): Promise<void> {
    await this.send({
      title: `Entry failed: ${raffle.name}`,
      url: raffleUrl(raffle.slug),
      description: message.slice(0, 1000),
      color: COLOR_FAILURE,
      timestamp: new Date().toISOString(),
    });
  }

  async won(raffle: RaffleForList, entry: RaffleEntry | undefined): Promise<void> {
    const fields: EmbedField[] = [];
    if (entry?.mintAddress) {
      fields.push({ name: 'Mint address', value: entry.mintAddress, inline: false });
    }
    await this.send({
      title: `You won: ${raffle.name}`,
      url: raffleUrl(raffle.slug),
      color: COLOR_WIN,
      fields,
      timestamp: new Date().toISOString(),
    });
  }

  async fatal(message: string): Promise<void> {
    await this.send({
      title: 'Alphabot Auto Entry stopped',
      description: message.slice(0, 1000),
      color: COLOR_FATAL,
      timestamp: new Date().toISOString(),
    });
  }

  async skipped(raffle: RaffleForList, reason: SkipReason): Promise<void> {
    log.debug(`Skipped ${raffle.slug}`, { reason, name: raffle.name });
  }

  private async send(embed: Embed): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      const response = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (!response.ok) {
        log.warn('Discord notification rejected', { status: response.status });
      }
    } catch (error) {
      log.warn('Discord notification failed', { message: (error as Error).message });
    }
  }
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run tests/notify/discord.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/notify/discord.ts tests/notify/discord.test.ts
git commit -m "feat: discord webhook notifier"
```

---

### Task 8: Discord OAuth2 and guild directory

**Files:**
- Create: `src/discord/oauth.ts`, `src/discord/guilds.ts`
- Test: `tests/discord/oauth.test.ts`, `tests/discord/guilds.test.ts`

**Interfaces:**
- Consumes: `log`.
- Produces:
  - `interface OAuthConfig { clientId: string; clientSecret: string; redirectUri: string }`
  - `interface TokenSet { accessToken: string; refreshToken: string; expiresAt: number }`
  - `buildAuthorizeUrl(cfg: OAuthConfig, state: string): string`
  - `createState(secret: string, now?: number): string`
  - `verifyState(state: string, secret: string, now?: number): boolean`
  - `exchangeCode(cfg: OAuthConfig, code: string, fetchImpl?: typeof fetch): Promise<TokenSet>`
  - `refreshTokens(cfg: OAuthConfig, refreshToken: string, fetchImpl?: typeof fetch): Promise<TokenSet>`
  - `fetchAllGuilds(accessToken: string, fetchImpl?: typeof fetch): Promise<{ id: string; name: string }[]>`
  - `class GuildDirectory { static open(dataDir, opts): Promise<GuildDirectory>; getGuildIds(): Promise<ReadonlySet<string>>; saveTokens(t: TokenSet): Promise<void>; get connected(): boolean; get lastRefreshedAt(): number | null }`

- [ ] **Step 1: Write the failing oauth test**

`tests/discord/oauth.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl, createState, exchangeCode, refreshTokens, verifyState,
} from '../../src/discord/oauth.js';

const cfg = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  redirectUri: 'https://app.up.railway.app/discord/callback',
};

describe('buildAuthorizeUrl', () => {
  it('requests the identify and guilds scopes', () => {
    const url = new URL(buildAuthorizeUrl(cfg, 'state-abc'));
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('identify guilds');
    expect(url.searchParams.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(url.searchParams.get('state')).toBe('state-abc');
  });
});

describe('state', () => {
  it('round-trips a freshly created state', () => {
    const state = createState('hmac-secret', 1000);
    expect(verifyState(state, 'hmac-secret', 2000)).toBe(true);
  });

  it('rejects a state signed with another secret', () => {
    const state = createState('hmac-secret', 1000);
    expect(verifyState(state, 'other-secret', 2000)).toBe(false);
  });

  it('rejects a state older than ten minutes', () => {
    const state = createState('hmac-secret', 1000);
    expect(verifyState(state, 'hmac-secret', 1000 + 600_001)).toBe(false);
  });

  it('rejects malformed state', () => {
    expect(verifyState('garbage', 'hmac-secret', 1000)).toBe(false);
  });
});

describe('exchangeCode', () => {
  it('posts form encoded credentials and maps the token set', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'at', refresh_token: 'rt', expires_in: 604800,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const tokens = await exchangeCode(cfg, 'the-code', fetchImpl as unknown as typeof fetch, 1000);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/v10/oauth2/token');
    expect((init.headers as Record<string, string>)['content-type'])
      .toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1000 + 604800 * 1000 });
  });

  it('throws a readable error when discord rejects the code', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(exchangeCode(cfg, 'bad', fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/invalid_grant/);
  });
});

describe('refreshTokens', () => {
  it('uses the refresh_token grant', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'at2', refresh_token: 'rt2', expires_in: 100,
    }), { status: 200 }));
    await refreshTokens(cfg, 'old-rt', fetchImpl as unknown as typeof fetch);
    const body = new URLSearchParams((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-rt');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/discord/oauth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/discord/oauth.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DISCORD_API = 'https://discord.com/api/v10';
const STATE_TTL_MS = 600_000;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function buildAuthorizeUrl(cfg: OAuthConfig, state: string): string {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', 'identify guilds');
  url.searchParams.set('state', state);
  return url.toString();
}

export function createState(secret: string, now: number = Date.now()): string {
  const signature = createHmac('sha256', secret).update(String(now)).digest('hex');
  return `${now}.${signature}`;
}

export function verifyState(state: string, secret: string, now: number = Date.now()): boolean {
  const [issuedRaw, signature] = state.split('.');
  if (!issuedRaw || !signature) return false;

  const issued = Number(issuedRaw);
  if (!Number.isFinite(issued)) return false;
  if (now - issued > STATE_TTL_MS || now < issued) return false;

  const expected = Buffer.from(createHmac('sha256', secret).update(issuedRaw).digest('hex'), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function tokenRequest(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  now: number,
): Promise<TokenSet> {
  const response = await fetchImpl(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Discord token request failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const json = JSON.parse(text) as TokenResponse;
  if (!json.access_token || !json.refresh_token) {
    throw new Error('Discord token response did not include the expected tokens');
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: now + (json.expires_in ?? 604800) * 1000,
  };
}

export function exchangeCode(
  cfg: OAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  });
  return tokenRequest(body, fetchImpl, now);
}

export function refreshTokens(
  cfg: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return tokenRequest(body, fetchImpl, now);
}
```

- [ ] **Step 4: Run the oauth test — expect PASS**

Run: `npx vitest run tests/discord/oauth.test.ts`

- [ ] **Step 5: Write the failing guilds test**

`tests/discord/guilds.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuildDirectory, fetchAllGuilds } from '../../src/discord/guilds.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'abguild-'));
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const guilds = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `g${i + offset}`, name: `Guild ${i + offset}` }));

const oauth = { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/discord/callback' };

describe('fetchAllGuilds', () => {
  it('paginates until a short page is returned', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(guilds(200)))
      .mockResolvedValueOnce(json(guilds(5, 200)));

    const all = await fetchAllGuilds('token', fetchImpl as unknown as typeof fetch);

    expect(all).toHaveLength(205);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondUrl = (fetchImpl.mock.calls[1] as [string])[0];
    expect(secondUrl).toContain('after=g199');
  });

  it('sends the bearer token', async () => {
    const fetchImpl = vi.fn(async () => json(guilds(1)));
    await fetchAllGuilds('my-token', fetchImpl as unknown as typeof fetch);
    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer my-token');
  });

  it('throws when discord rejects the token', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    await expect(fetchAllGuilds('bad', fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/401/);
  });
});

describe('GuildDirectory', () => {
  it('reports not connected and returns only manual ids before oauth', async () => {
    const dir = await GuildDirectory.open(tempDir(), {
      manualGuildIds: ['manual-1'], oauth, refreshHours: 6,
    });
    expect(dir.connected).toBe(false);
    expect([...(await dir.getGuildIds())]).toEqual(['manual-1']);
  });

  it('merges oauth guilds with manual ids after saving tokens', async () => {
    const fetchImpl = vi.fn(async () => json([{ id: 'g1', name: 'One' }]));
    const dir = await GuildDirectory.open(tempDir(), {
      manualGuildIds: ['manual-1'], oauth, refreshHours: 6,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await dir.saveTokens({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1e6 });
    const ids = await dir.getGuildIds();

    expect(dir.connected).toBe(true);
    expect([...ids].sort()).toEqual(['g1', 'manual-1']);
  });

  it('caches the guild list for refreshHours', async () => {
    const fetchImpl = vi.fn(async () => json([{ id: 'g1', name: 'One' }]));
    const dir = await GuildDirectory.open(tempDir(), {
      manualGuildIds: [], oauth, refreshHours: 6,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await dir.saveTokens({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1e6 });
    await dir.getGuildIds();
    await dir.getGuildIds();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('persists tokens and the guild list across reopen', async () => {
    const path = tempDir();
    const fetchImpl = vi.fn(async () => json([{ id: 'g1', name: 'One' }]));
    const first = await GuildDirectory.open(path, {
      manualGuildIds: [], oauth, refreshHours: 6,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await first.saveTokens({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1e6 });
    await first.getGuildIds();

    const second = await GuildDirectory.open(path, {
      manualGuildIds: [], oauth, refreshHours: 6,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(second.connected).toBe(true);
    expect([...(await second.getGuildIds())]).toEqual(['g1']);
  });

  it('keeps serving the cached list when a refresh fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json([{ id: 'g1', name: 'One' }]))
      .mockRejectedValue(new Error('discord down'));
    const dir = await GuildDirectory.open(tempDir(), {
      manualGuildIds: [], oauth, refreshHours: 0.000001,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await dir.saveTokens({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1e6 });
    await dir.getGuildIds();
    await new Promise((r) => setTimeout(r, 10));
    expect([...(await dir.getGuildIds())]).toEqual(['g1']);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run tests/discord/guilds.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `src/discord/guilds.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../logger.js';
import { DISCORD_API, refreshTokens, type OAuthConfig, type TokenSet } from './oauth.js';

const FILE_NAME = 'discord.json';
const PAGE_SIZE = 200;

export interface Guild {
  id: string;
  name: string;
}

export async function fetchAllGuilds(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Guild[]> {
  const all: Guild[] = [];
  let after: string | undefined;

  for (;;) {
    const url = new URL(`${DISCORD_API}/users/@me/guilds`);
    url.searchParams.set('limit', String(PAGE_SIZE));
    if (after) url.searchParams.set('after', after);

    const response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Discord guild list failed (${response.status})`);
    }

    const page = (await response.json()) as Guild[];
    all.push(...page);

    if (page.length < PAGE_SIZE) break;
    after = page[page.length - 1]?.id;
    if (!after) break;
  }

  return all;
}

interface PersistedState {
  tokens?: TokenSet;
  guildIds?: string[];
  refreshedAt?: number;
}

export interface GuildDirectoryOptions {
  manualGuildIds: string[];
  oauth: OAuthConfig | null;
  refreshHours: number;
  fetchImpl?: typeof fetch;
}

export class GuildDirectory {
  private refreshing: Promise<void> | null = null;

  private constructor(
    private readonly filePath: string,
    private state: PersistedState,
    private readonly opts: GuildDirectoryOptions,
  ) {}

  static async open(dataDir: string, opts: GuildDirectoryOptions): Promise<GuildDirectory> {
    const filePath = join(dataDir, FILE_NAME);
    let state: PersistedState = {};
    try {
      state = JSON.parse(await readFile(filePath, 'utf8')) as PersistedState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('discord.json was unreadable and will be rebuilt');
      }
    }
    return new GuildDirectory(filePath, state, opts);
  }

  get connected(): boolean {
    return Boolean(this.state.tokens);
  }

  get lastRefreshedAt(): number | null {
    return this.state.refreshedAt ?? null;
  }

  async saveTokens(tokens: TokenSet): Promise<void> {
    this.state = { ...this.state, tokens };
    await this.persist();
    await this.refresh();
  }

  async getGuildIds(): Promise<ReadonlySet<string>> {
    if (this.connected && this.isStale()) {
      this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
      await this.refreshing;
    }
    return new Set([...(this.state.guildIds ?? []), ...this.opts.manualGuildIds]);
  }

  private isStale(): boolean {
    const refreshedAt = this.state.refreshedAt;
    if (refreshedAt === undefined) return true;
    return Date.now() - refreshedAt >= this.opts.refreshHours * 3_600_000;
  }

  private async refresh(): Promise<void> {
    const tokens = this.state.tokens;
    if (!tokens) return;

    try {
      let active = tokens;
      if (this.opts.oauth && active.expiresAt - Date.now() < 86_400_000) {
        active = await refreshTokens(this.opts.oauth, active.refreshToken, this.opts.fetchImpl);
      }

      const guilds = await fetchAllGuilds(active.accessToken, this.opts.fetchImpl);
      this.state = {
        tokens: active,
        guildIds: guilds.map((g) => g.id),
        refreshedAt: Date.now(),
      };
      await this.persist();
      log.info(`Discord guild list refreshed: ${guilds.length} servers`);
    } catch (error) {
      log.warn('Could not refresh the Discord guild list; keeping the cached one', {
        message: (error as Error).message,
      });
    }
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(join(this.filePath, '..'), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(this.state, null, 2), 'utf8');
      await rename(tmpPath, this.filePath);
    } catch (error) {
      log.warn('Could not persist discord.json', { message: (error as Error).message });
    }
  }
}
```

- [ ] **Step 8: Run the guilds test — expect PASS**

Run: `npx vitest run tests/discord/guilds.test.ts`

- [ ] **Step 8: Commit**

```bash
git add src/discord tests/discord
git commit -m "feat: discord oauth2 and cached guild directory"
```

---

### Task 9: Entry queue

**Files:**
- Create: `src/core/entry-queue.ts`
- Test: `tests/core/entry-queue.test.ts`

**Interfaces:**
- Consumes: `AppConfig`, `AlphabotClient`, `register`, `EntryStore`, `evaluate`, `DiscordNotifier`, `GuildDirectory`.
- Produces:
  - `interface EntryQueueDeps { config: AppConfig; client: AlphabotClient; store: EntryStore; notifier: DiscordNotifier; guilds: { getGuildIds(): Promise<ReadonlySet<string>> }; sleep?: (ms: number) => Promise<void>; onAuthError?: (error: Error) => void }`
  - `class EntryQueue { constructor(deps); submit(raffle: RaffleWithRequirements, source: 'webhook' | 'poller'): void; get depth(): number; idle(): Promise<void> }`

`idle()` resolves when the queue has finished everything currently pending — tests await it instead of using timers.

- [ ] **Step 1: Write the failing test**

`tests/core/entry-queue.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EntryQueue } from '../../src/core/entry-queue.js';
import { AuthError } from '../../src/api/client.js';
import type { AppConfig } from '../../src/config.js';
import type { RaffleWithRequirements } from '../../src/api/types.js';

const config = (over: Partial<AppConfig['entry']> = {}): AppConfig => ({
  poll: { enabled: true, intervalSeconds: 600, pageSize: 50 },
  entry: {
    delayMs: 700, dryRun: false, skipCaptcha: true, skipNftHolding: true,
    skipTokenGated: true, allowedBlockchains: [], excludeKeywords: [], minWinnerCount: 0,
    ...over,
  },
  discord: { requireGuildWhitelist: true, guildIds: [], refreshHours: 6 },
  submission: { mintAddress: null, discordId: null, twitterId: null, telegramId: null },
  env: { rafflePassword: null } as AppConfig['env'],
});

const raffle = (over: Partial<RaffleWithRequirements> = {}): RaffleWithRequirements => ({
  _id: '1', slug: 'r1', name: 'Raffle One', status: 'active',
  endDate: Date.now() + 60_000, winnerCount: 5, ...over,
});

function harness(over: Record<string, unknown> = {}) {
  const post = vi.fn(async () => ({ validation: { success: true, entries: 1 } }));
  const entered: string[] = [];
  const store = {
    has: (slug: string) => entered.includes(slug),
    record: vi.fn(async (r: { slug: string }) => { entered.push(r.slug); }),
  };
  const notifier = {
    entered: vi.fn(async () => {}), failed: vi.fn(async () => {}),
    skipped: vi.fn(async () => {}), won: vi.fn(async () => {}), fatal: vi.fn(async () => {}),
  };
  const queue = new EntryQueue({
    config: config(),
    client: { post, get: vi.fn() },
    store,
    notifier,
    guilds: { getGuildIds: async () => new Set<string>(['guild-a']) },
    sleep: async () => {},
    ...over,
  } as never);
  return { queue, post, store, notifier, entered };
}

beforeEach(() => vi.clearAllMocks());

describe('EntryQueue', () => {
  it('registers an eligible raffle and records it', async () => {
    const { queue, post, store, notifier } = harness();
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    expect(post).toHaveBeenCalledWith('register', { slug: 'r1' });
    expect(store.record).toHaveBeenCalledOnce();
    expect(notifier.entered).toHaveBeenCalledOnce();
  });

  it('does not register a filtered raffle', async () => {
    const { queue, post, notifier } = harness();
    queue.submit(raffle({ connectCaptcha: true }), 'webhook');
    await queue.idle();

    expect(post).not.toHaveBeenCalled();
    expect(notifier.skipped).toHaveBeenCalledOnce();
  });

  it('deduplicates the same slug submitted twice before processing', async () => {
    const { queue, post } = harness();
    queue.submit(raffle(), 'webhook');
    queue.submit(raffle(), 'poller');
    await queue.idle();
    expect(post).toHaveBeenCalledOnce();
  });

  it('processes sequentially with the configured delay', async () => {
    const sleep = vi.fn(async () => {});
    const { queue, post } = harness({ sleep });
    queue.submit(raffle({ slug: 'a' }), 'webhook');
    queue.submit(raffle({ slug: 'b' }), 'webhook');
    await queue.idle();

    expect(post).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(700);
  });

  it('records the failure and notifies when validation fails', async () => {
    const post = vi.fn(async () => ({
      resultMd: 'Not in server', validation: { success: false, reason: 'discord_invalid' },
    }));
    const { queue, notifier, store } = harness({ client: { post, get: vi.fn() } });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    expect(notifier.failed).toHaveBeenCalledOnce();
    expect(store.record).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, reason: 'discord_invalid' }),
    );
  });

  it('records an api error without crashing the queue', async () => {
    const post = vi.fn().mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ validation: { success: true, entries: 1 } });
    const { queue, notifier, store } = harness({ client: { post, get: vi.fn() } });
    queue.submit(raffle({ slug: 'a' }), 'webhook');
    queue.submit(raffle({ slug: 'b' }), 'webhook');
    await queue.idle();

    expect(notifier.failed).toHaveBeenCalledOnce();
    expect(store.record).toHaveBeenCalledTimes(2);
  });

  it('reports auth errors through onAuthError and stops entering', async () => {
    const post = vi.fn(async () => { throw new AuthError('bad key'); });
    const onAuthError = vi.fn();
    const { queue, notifier } = harness({ client: { post, get: vi.fn() }, onAuthError });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    expect(onAuthError).toHaveBeenCalledOnce();
    expect(notifier.fatal).toHaveBeenCalledOnce();
  });

  it('does not POST in dry run but still notifies', async () => {
    const { queue, post, notifier } = harness({ config: config({ dryRun: true }) });
    queue.submit(raffle(), 'webhook');
    await queue.idle();

    expect(post).not.toHaveBeenCalled();
    expect(notifier.entered).toHaveBeenCalledOnce();
  });

  it('passes configured submission overrides to register', async () => {
    const cfg = config();
    cfg.submission.mintAddress = '0xdead';
    const { queue, post } = harness({ config: cfg });
    queue.submit(raffle(), 'webhook');
    await queue.idle();
    expect(post).toHaveBeenCalledWith('register', { slug: 'r1', mintAddress: '0xdead' });
  });

  it('reports queue depth', () => {
    const { queue } = harness();
    queue.submit(raffle({ slug: 'a' }), 'webhook');
    queue.submit(raffle({ slug: 'b' }), 'webhook');
    expect(queue.depth).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/core/entry-queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/entry-queue.ts`**

```ts
import { AuthError, type AlphabotClient } from '../api/client.js';
import { register, type RegisterInput } from '../api/raffles.js';
import type { RaffleWithRequirements } from '../api/types.js';
import type { AppConfig } from '../config.js';
import { log } from '../logger.js';
import type { DiscordNotifier } from '../notify/discord.js';
import { evaluate } from './filter.js';
import type { EntryStore } from './store.js';

export type EntrySource = 'webhook' | 'poller';

export interface EntryQueueDeps {
  config: AppConfig;
  client: AlphabotClient;
  store: Pick<EntryStore, 'has' | 'record'>;
  notifier: DiscordNotifier;
  guilds: { getGuildIds: () => Promise<ReadonlySet<string>> };
  sleep?: (ms: number) => Promise<void>;
  onAuthError?: (error: Error) => void;
}

interface QueueItem {
  raffle: RaffleWithRequirements;
  source: EntrySource;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class EntryQueue {
  private readonly pending: QueueItem[] = [];
  private readonly seen = new Set<string>();
  private running: Promise<void> | null = null;
  private authFailed = false;

  constructor(private readonly deps: EntryQueueDeps) {}

  get depth(): number {
    return this.pending.length;
  }

  submit(raffle: RaffleWithRequirements, source: EntrySource): void {
    if (this.seen.has(raffle.slug)) return;
    this.seen.add(raffle.slug);
    this.pending.push({ raffle, source });
    this.running ??= this.run().finally(() => { this.running = null; });
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async run(): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    let first = true;

    while (this.pending.length > 0) {
      const item = this.pending.shift();
      if (!item) break;

      if (!first) await sleep(this.deps.config.entry.delayMs);
      first = false;

      await this.process(item);
    }
  }

  private async process({ raffle, source }: QueueItem): Promise<void> {
    const { config, store, notifier, guilds, client } = this.deps;

    if (this.authFailed) return;

    const knownGuildIds = await guilds.getGuildIds();
    const verdict = evaluate(raffle, {
      config,
      knownGuildIds,
      isEntered: (slug) => store.has(slug),
      hasPassword: config.env.rafflePassword !== null,
      fromWebhook: source === 'webhook',
    });

    if (!verdict.eligible) {
      await notifier.skipped(raffle, verdict.reason);
      return;
    }

    const input: RegisterInput = { slug: raffle.slug };
    const { mintAddress, discordId, twitterId, telegramId } = config.submission;
    if (mintAddress) input.mintAddress = mintAddress;
    if (discordId) input.discordId = discordId;
    if (twitterId) input.twitterId = twitterId;
    if (telegramId) input.telegramId = telegramId;

    if (config.entry.dryRun) {
      log.info(`DRY RUN would enter ${raffle.slug}`, { name: raffle.name });
      await notifier.entered(raffle, { success: true, entries: null, reason: null, resultMd: 'dry run' });
      return;
    }

    try {
      const outcome = await register(client, input);

      await store.record({
        slug: raffle.slug,
        name: raffle.name,
        at: Date.now(),
        success: outcome.success,
        entries: outcome.entries,
        reason: outcome.reason,
      });

      if (outcome.success) {
        log.info(`Entered ${raffle.slug}`, { entries: outcome.entries, source });
        await notifier.entered(raffle, outcome);
      } else {
        log.warn(`Entry rejected for ${raffle.slug}`, { reason: outcome.reason });
        await notifier.failed(raffle, outcome.reason ?? outcome.resultMd ?? 'Entry was rejected');
      }
    } catch (error) {
      if (error instanceof AuthError) {
        this.authFailed = true;
        log.error('Alphabot authentication failed; no further entries will be attempted');
        await notifier.fatal(error.message);
        this.deps.onAuthError?.(error);
        return;
      }

      const message = (error as Error).message;
      log.error(`Entry failed for ${raffle.slug}`, { message });
      await store.record({
        slug: raffle.slug,
        name: raffle.name,
        at: Date.now(),
        success: false,
        entries: null,
        reason: message,
      });
      await notifier.failed(raffle, message);
    }
  }
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run tests/core/entry-queue.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/entry-queue.ts tests/core/entry-queue.test.ts
git commit -m "feat: serial entry queue with dedupe, pacing and auth cutoff"
```

---

### Task 10: Webhook event handler

**Files:**
- Create: `src/webhook/handlers.ts`
- Test: `tests/webhook/handlers.test.ts`

**Interfaces:**
- Consumes: `EntryQueue`, `DiscordNotifier`, `WebhookBody`.
- Produces:
  - `interface HandlerDeps { queue: Pick<EntryQueue, 'submit'>; notifier: DiscordNotifier }`
  - `handleEvent(body: WebhookBody, deps: HandlerDeps): Promise<void>`

- [ ] **Step 1: Write the failing test**

`tests/webhook/handlers.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { handleEvent } from '../../src/webhook/handlers.js';
import type { WebhookBody } from '../../src/api/types.js';

const raffle = { _id: '1', slug: 'r1', name: 'R1', status: 'active' };

function deps() {
  return {
    queue: { submit: vi.fn() },
    notifier: {
      entered: vi.fn(), failed: vi.fn(), skipped: vi.fn(),
      won: vi.fn(async () => {}), fatal: vi.fn(),
    },
  } as never;
}

const body = (over: Partial<WebhookBody>): WebhookBody => ({
  event: 'raffle:active', timestamp: 1, hash: 'h', ...over,
});

describe('handleEvent', () => {
  it('submits raffle:active to the queue as a webhook source', async () => {
    const d = deps();
    await handleEvent(body({ event: 'raffle:active', data: { raffle } }), d);
    expect((d as never as { queue: { submit: ReturnType<typeof vi.fn> } }).queue.submit)
      .toHaveBeenCalledWith(raffle, 'webhook');
  });

  it('notifies on raffle:won', async () => {
    const d = deps() as never as { notifier: { won: ReturnType<typeof vi.fn> } };
    await handleEvent(body({ event: 'raffle:won', data: { raffle, entry: { mintAddress: '0x1' } } }), d as never);
    expect(d.notifier.won).toHaveBeenCalledWith(raffle, { mintAddress: '0x1' });
  });

  it('ignores raffle:active without a raffle payload', async () => {
    const d = deps() as never as { queue: { submit: ReturnType<typeof vi.fn> } };
    await handleEvent(body({ event: 'raffle:active', data: {} }), d as never);
    expect(d.queue.submit).not.toHaveBeenCalled();
  });

  it('ignores unrelated events without throwing', async () => {
    const d = deps() as never as { queue: { submit: ReturnType<typeof vi.fn> } };
    await expect(handleEvent(body({ event: 'project:minting' }), d as never)).resolves.toBeUndefined();
    expect(d.queue.submit).not.toHaveBeenCalled();
  });

  it('acknowledges webhook:test without side effects', async () => {
    const d = deps() as never as { queue: { submit: ReturnType<typeof vi.fn> } };
    await expect(handleEvent(body({ event: 'webhook:test' }), d as never)).resolves.toBeUndefined();
    expect(d.queue.submit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/webhook/handlers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/webhook/handlers.ts`**

```ts
import type { WebhookBody } from '../api/types.js';
import type { EntryQueue } from '../core/entry-queue.js';
import { log } from '../logger.js';
import type { DiscordNotifier } from '../notify/discord.js';

export interface HandlerDeps {
  queue: Pick<EntryQueue, 'submit'>;
  notifier: DiscordNotifier;
}

export async function handleEvent(body: WebhookBody, deps: HandlerDeps): Promise<void> {
  const raffle = body.data?.raffle;

  switch (body.event) {
    case 'raffle:active': {
      if (!raffle) {
        log.warn('raffle:active arrived without a raffle payload');
        return;
      }
      log.info(`Webhook raffle:active ${raffle.slug}`, { name: raffle.name });
      deps.queue.submit(raffle, 'webhook');
      return;
    }

    case 'raffle:won': {
      if (!raffle) return;
      log.info(`Won raffle ${raffle.slug}`, { name: raffle.name });
      await deps.notifier.won(raffle, body.data?.entry);
      return;
    }

    case 'webhook:test': {
      log.info('Received webhook:test from Alphabot');
      return;
    }

    default:
      log.debug(`Ignoring event ${body.event}`);
  }
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run tests/webhook/handlers.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/webhook/handlers.ts tests/webhook/handlers.test.ts
git commit -m "feat: alphabot webhook event routing"
```

---

### Task 11: Poller

**Files:**
- Create: `src/core/poller.ts`
- Test: `tests/core/poller.test.ts`

**Interfaces:**
- Consumes: `AlphabotClient`, `listActiveRaffles`, `EntryQueue`, `AppConfig`.
- Produces:
  - `interface PollerDeps { config: AppConfig; client: AlphabotClient; queue: Pick<EntryQueue, 'submit'> }`
  - `class Poller { constructor(deps: PollerDeps); runOnce(): Promise<number>; start(): void; stop(): void }`

- [ ] **Step 1: Write the failing test**

`tests/core/poller.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Poller } from '../../src/core/poller.js';
import { AuthError, BudgetExhaustedError } from '../../src/api/client.js';
import type { AppConfig } from '../../src/config.js';

const config = { poll: { enabled: true, intervalSeconds: 600, pageSize: 50 } } as AppConfig;

function make(get: ReturnType<typeof vi.fn>) {
  const submit = vi.fn();
  const poller = new Poller({
    config,
    client: { get, post: vi.fn() } as never,
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

  it('returns zero and does not throw when the GET budget is spent', async () => {
    const get = vi.fn(async () => { throw new BudgetExhaustedError('spent'); });
    const { poller, submit } = make(get);

    await expect(poller.runOnce()).resolves.toBe(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it('stops the interval after an auth error', async () => {
    const get = vi.fn(async () => { throw new AuthError('bad key'); });
    const { poller } = make(get);

    poller.start();
    await poller.runOnce();
    expect(poller.stopped).toBe(true);
    poller.stop();
  });

  it('swallows unexpected errors so the interval survives', async () => {
    const get = vi.fn(async () => { throw new Error('network'); });
    const { poller } = make(get);
    await expect(poller.runOnce()).resolves.toBe(0);
    expect(poller.stopped).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/core/poller.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/poller.ts`**

```ts
import { AuthError, BudgetExhaustedError, type AlphabotClient } from '../api/client.js';
import { listActiveRaffles } from '../api/raffles.js';
import type { AppConfig } from '../config.js';
import { log } from '../logger.js';
import type { EntryQueue } from './entry-queue.js';

export interface PollerDeps {
  config: AppConfig;
  client: AlphabotClient;
  queue: Pick<EntryQueue, 'submit'>;
}

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private halted = false;

  constructor(private readonly deps: PollerDeps) {}

  get stopped(): boolean {
    return this.halted;
  }

  async runOnce(): Promise<number> {
    const { client, config, queue } = this.deps;

    try {
      const raffles = await listActiveRaffles(client, { pageSize: config.poll.pageSize });
      for (const raffle of raffles) queue.submit(raffle, 'poller');
      log.info(`Poller found ${raffles.length} unregistered active raffles`, {
        getBudgetRemaining: client.budgetRemaining,
      });
      return raffles.length;
    } catch (error) {
      if (error instanceof AuthError) {
        this.halted = true;
        this.stop();
        log.error('Poller halted: Alphabot rejected the API key');
        return 0;
      }
      if (error instanceof BudgetExhaustedError) {
        log.warn('Poller skipped this cycle to protect the hourly GET budget');
        return 0;
      }
      log.warn('Poller cycle failed', { message: (error as Error).message });
      return 0;
    }
  }

  start(): void {
    if (!this.deps.config.poll.enabled || this.timer) return;
    const intervalMs = this.deps.config.poll.intervalSeconds * 1000;
    this.timer = setInterval(() => { void this.runOnce(); }, intervalMs);
    this.timer.unref?.();
    log.info(`Poller started, every ${this.deps.config.poll.intervalSeconds}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run tests/core/poller.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/poller.ts tests/core/poller.test.ts
git commit -m "feat: catch-up poller guarded by the get budget"
```

---

### Task 12: HTTP server and routes

**Files:**
- Create: `src/webhook/server.ts`
- Test: `tests/webhook/server.test.ts`

**Interfaces:**
- Consumes: everything built so far.
- Produces:
  - `interface ServerDeps { config: AppConfig; queue: Pick<EntryQueue, 'submit' | 'depth'>; notifier: DiscordNotifier; guilds: GuildDirectory; store: Pick<EntryStore, 'size'>; client: Pick<AlphabotClient, 'budgetRemaining'>; startedAt: number; fetchImpl?: typeof fetch }`
  - `createServer(deps: ServerDeps): http.Server`

Routes: `POST /alphabot`, `GET /health`, `GET /discord/connect`, `GET /discord/callback`, everything else `404`.

- [ ] **Step 1: Write the failing test**

`tests/webhook/server.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from '../../src/webhook/server.js';
import type { AppConfig } from '../../src/config.js';

const KEY = 'server-test-key';

const config = (over: Partial<AppConfig['env']> = {}): AppConfig => ({
  poll: { enabled: false, intervalSeconds: 600, pageSize: 50 },
  entry: {
    delayMs: 700, dryRun: false, skipCaptcha: true, skipNftHolding: true,
    skipTokenGated: true, allowedBlockchains: [], excludeKeywords: [], minWinnerCount: 0,
  },
  discord: { requireGuildWhitelist: true, guildIds: [], refreshHours: 6 },
  submission: { mintAddress: null, discordId: null, twitterId: null, telegramId: null },
  env: {
    alphabotApiKey: KEY, port: 0, dataDir: './data', publicBaseUrl: 'https://app.test',
    discordClientId: 'cid', discordClientSecret: 'csecret',
    notifyWebhookUrl: null, rafflePassword: null, ...over,
  },
});

let server: Server | null = null;

function start(over: Record<string, unknown> = {}) {
  const submit = vi.fn();
  server = createServer({
    config: config(),
    queue: { submit, depth: 0 },
    notifier: { won: vi.fn(async () => {}) } as never,
    guilds: { connected: true, lastRefreshedAt: 1, saveTokens: vi.fn(async () => {}) } as never,
    store: { size: 3 },
    client: { budgetRemaining: 27 },
    startedAt: Date.now(),
    ...over,
  } as never);
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, submit };
}

afterEach(() => { server?.close(); server = null; });

function signedBody(event: string, data: unknown = {}) {
  const timestamp = Date.now();
  const hash = createHmac('sha256', KEY).update(`${event}\n${timestamp}`).digest('hex');
  return JSON.stringify({ event, timestamp, hash, data });
}

describe('server', () => {
  it('answers GET /health with status json', async () => {
    const { base } = start();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.entered).toBe(3);
    expect(body.getBudgetRemaining).toBe(27);
    expect(body.discordConnected).toBe(true);
  });

  it('accepts a correctly signed raffle:active and queues it', async () => {
    const { base, submit } = start();
    const response = await fetch(`${base}/alphabot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: signedBody('raffle:active', { raffle: { slug: 'r1', name: 'R1', status: 'active' } }),
    });
    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(submit).toHaveBeenCalledOnce();
  });

  it('answers 200 but ignores a badly signed webhook', async () => {
    const { base, submit } = start();
    const response = await fetch(`${base}/alphabot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'raffle:active', timestamp: 1, hash: 'nope', data: {} }),
    });
    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(submit).not.toHaveBeenCalled();
  });

  it('answers 200 to malformed json', async () => {
    const { base } = start();
    const response = await fetch(`${base}/alphabot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(200);
  });

  it('redirects /discord/connect to discord', async () => {
    const { base } = start();
    const response = await fetch(`${base}/discord/connect`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') as string);
    expect(location.host).toBe('discord.com');
    expect(location.searchParams.get('scope')).toBe('identify guilds');
    expect(location.searchParams.get('redirect_uri'))
      .toBe('https://app.test/discord/callback');
  });

  it('rejects a callback with an invalid state', async () => {
    const { base } = start();
    const response = await fetch(`${base}/discord/callback?code=x&state=bogus`);
    expect(response.status).toBe(400);
  });

  it('returns 404 for unknown routes', async () => {
    const { base } = start();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/webhook/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/webhook/server.ts`**

```ts
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AlphabotClient } from '../api/client.js';
import type { AppConfig } from '../config.js';
import type { EntryQueue } from '../core/entry-queue.js';
import type { EntryStore } from '../core/store.js';
import {
  buildAuthorizeUrl, createState, exchangeCode, verifyState, type OAuthConfig,
} from '../discord/oauth.js';
import type { GuildDirectory } from '../discord/guilds.js';
import { log } from '../logger.js';
import type { DiscordNotifier } from '../notify/discord.js';
import { handleEvent } from './handlers.js';
import { verifyWebhook } from './verify.js';

export interface ServerDeps {
  config: AppConfig;
  queue: Pick<EntryQueue, 'submit' | 'depth'>;
  notifier: DiscordNotifier;
  guilds: Pick<GuildDirectory, 'connected' | 'lastRefreshedAt' | 'saveTokens'>;
  store: Pick<EntryStore, 'size'>;
  client: Pick<AlphabotClient, 'budgetRemaining'>;
  startedAt: number;
  fetchImpl?: typeof fetch;
}

const MAX_BODY_BYTES = 1_000_000;

function send(res: ServerResponse, status: number, body: string, contentType = 'text/plain'): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function oauthConfig(config: AppConfig): OAuthConfig | null {
  const { discordClientId, discordClientSecret, publicBaseUrl } = config.env;
  if (!discordClientId || !discordClientSecret || !publicBaseUrl) return null;
  return {
    clientId: discordClientId,
    clientSecret: discordClientSecret,
    redirectUri: `${publicBaseUrl}/discord/callback`,
  };
}

export function createServer(deps: ServerDeps): Server {
  const { config } = deps;
  const apiKey = config.env.alphabotApiKey;

  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, JSON.stringify({
        ok: true,
        uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
        queueDepth: deps.queue.depth,
        entered: deps.store.size,
        getBudgetRemaining: deps.client.budgetRemaining,
        discordConnected: deps.guilds.connected,
        discordRefreshedAt: deps.guilds.lastRefreshedAt,
        dryRun: config.entry.dryRun,
      }), 'application/json');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/alphabot') {
      // Alphabot requires a fast 200 for every delivery, valid or not.
      void readBody(req)
        .then((raw) => {
          send(res, 200, '');
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            log.warn('Webhook body was not valid JSON');
            return;
          }
          if (!verifyWebhook(parsed, apiKey)) {
            log.warn('Webhook hash did not verify; dropping', { from: req.socket.remoteAddress });
            return;
          }
          void handleEvent(parsed, { queue: deps.queue, notifier: deps.notifier })
            .catch((error: Error) => log.error('Webhook handler failed', { message: error.message }));
        })
        .catch(() => send(res, 200, ''));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/discord/connect') {
      const oauth = oauthConfig(config);
      if (!oauth) {
        send(res, 503, 'Discord OAuth is not configured. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and PUBLIC_BASE_URL.');
        return;
      }
      res.writeHead(302, { location: buildAuthorizeUrl(oauth, createState(apiKey)) });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/discord/callback') {
      const oauth = oauthConfig(config);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (!oauth) {
        send(res, 503, 'Discord OAuth is not configured.');
        return;
      }
      if (!code || !state || !verifyState(state, apiKey)) {
        send(res, 400, 'Invalid or expired OAuth state. Start again at /discord/connect.');
        return;
      }

      void exchangeCode(oauth, code, deps.fetchImpl)
        .then((tokens) => deps.guilds.saveTokens(tokens))
        .then(() => send(res, 200, 'Discord connected. Your server list will refresh automatically.'))
        .catch((error: Error) => {
          log.error('Discord OAuth callback failed', { message: error.message });
          send(res, 502, 'Could not complete the Discord connection. Check the logs.');
        });
      return;
    }

    send(res, 404, 'Not found');
  });
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run tests/webhook/server.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/webhook/server.ts tests/webhook/server.test.ts
git commit -m "feat: http server with webhook, health and discord oauth routes"
```

---

### Task 13: Bootstrap, Docker, Railway config and README

**Files:**
- Create: `src/index.ts`, `Dockerfile`, `.dockerignore`, `railway.json`, `README.md`
- Test: manual smoke test (documented below)

**Interfaces:**
- Consumes: every module.
- Produces: a runnable service.

- [ ] **Step 1: Implement `src/index.ts`**

```ts
import 'dotenv/config';
import { AlphabotClient } from './api/client.js';
import { loadConfig } from './config.js';
import { EntryQueue } from './core/entry-queue.js';
import { Poller } from './core/poller.js';
import { EntryStore } from './core/store.js';
import { GuildDirectory } from './discord/guilds.js';
import { log, registerSecret } from './logger.js';
import { DiscordNotifier } from './notify/discord.js';
import { createServer } from './webhook/server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  registerSecret(config.env.alphabotApiKey);
  registerSecret(config.env.discordClientSecret);
  registerSecret(config.env.notifyWebhookUrl);
  registerSecret(config.env.rafflePassword);

  const dryRun = process.argv.includes('--dry-run') || config.entry.dryRun;
  const effective = dryRun
    ? { ...config, entry: { ...config.entry, dryRun: true } }
    : config;

  const client = new AlphabotClient({ apiKey: effective.env.alphabotApiKey });
  const store = await EntryStore.open(effective.env.dataDir);
  const notifier = new DiscordNotifier(effective.env.notifyWebhookUrl);

  const oauth = effective.env.discordClientId
    && effective.env.discordClientSecret
    && effective.env.publicBaseUrl
    ? {
      clientId: effective.env.discordClientId,
      clientSecret: effective.env.discordClientSecret,
      redirectUri: `${effective.env.publicBaseUrl}/discord/callback`,
    }
    : null;

  const guilds = await GuildDirectory.open(effective.env.dataDir, {
    manualGuildIds: effective.discord.guildIds,
    oauth,
    refreshHours: effective.discord.refreshHours,
  });

  if (effective.discord.requireGuildWhitelist && !guilds.connected
      && effective.discord.guildIds.length === 0) {
    log.warn(
      'No Discord guilds are known yet, so every Discord-gated raffle will be skipped. '
      + 'Visit /discord/connect to authorize, or set DISCORD_GUILD_IDS.',
    );
  }

  // Declared before the queue so onAuthError can stop it, assigned right after.
  let poller: Poller | null = null;

  const queue = new EntryQueue({
    config: effective,
    client,
    store,
    notifier,
    guilds,
    onAuthError: () => poller?.stop(),
  });

  poller = new Poller({ config: effective, client, queue });

  const server = createServer({
    config: effective,
    queue,
    notifier,
    guilds,
    store,
    client,
    startedAt: Date.now(),
  });

  server.listen(effective.env.port, () => {
    log.info(`Listening on port ${effective.env.port}`, { dryRun });
    if (effective.env.publicBaseUrl) {
      log.info(`Set the Alphabot webhook URL to ${effective.env.publicBaseUrl}/alphabot`);
    }
  });

  if (process.argv.includes('--once')) {
    await poller.runOnce();
    await queue.idle();
    server.close();
    return;
  }

  poller.start();
  void poller.runOnce();

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down`);
    poller?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: Error) => {
  log.error('Fatal startup error', { message: error.message });
  process.exit(1);
});
```

- [ ] **Step 2: Write `Dockerfile`**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config.json ./config.json
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Write `.dockerignore`**

```gitignore
node_modules
dist
data
coverage
tests
docs
.env
.git
```

- [ ] **Step 4: Write `railway.json`**

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": {
    "startCommand": "node dist/index.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

- [ ] **Step 5: Write `README.md`**

````markdown
# Alphabot Auto Entry

Automatically enters Alphabot NFT raffles for **your own account** using Alphabot's official
public API. Alphabot pushes `raffle:active` webhooks; the bot decides whether you qualify and
registers the entry within seconds.

Requires an active Alphabot subscription (the API is subscription-gated).

## How it works

- `raffle:active` webhook is the primary trigger. Its payload carries the full requirement set,
  including which Discord servers a raffle is gated on.
- A poller runs every 10 minutes as a downtime safety net. `GET /raffles` is limited to
  30 requests per hour, so the client caps usable GETs at 28 per rolling hour.
- Raffles are matched against the Discord servers you have actually joined, read through
  OAuth2 (`identify guilds`). No user token, no self-bot.
- Every attempt is recorded, so a raffle is never entered twice.

## Local setup

```bash
npm install
cp .env.example .env      # fill in ALPHABOT_API_KEY
npm test
npm run build
npm start -- --dry-run    # rehearse without registering anything
```

`npm start -- --once` runs a single poll cycle and exits.

## Deploy to Railway

1. Push this repo to GitHub and create a Railway service from it. The build uses `Dockerfile`.
2. **Volume:** add one mounted at `/data`, then set `DATA_DIR=/data`.
3. **Domain:** Settings, Networking, Generate Domain.
4. **Variables:**

   | Variable | Value |
   |---|---|
   | `ALPHABOT_API_KEY` | from your Alphabot profile |
   | `PUBLIC_BASE_URL` | `https://<your-domain>` |
   | `DATA_DIR` | `/data` |
   | `DISCORD_CLIENT_ID` | Discord application id |
   | `DISCORD_CLIENT_SECRET` | Discord application secret |
   | `DISCORD_NOTIFY_WEBHOOK_URL` | a channel webhook in your own server |
   | `DISCORD_GUILD_IDS` | optional, comma separated, merged with the OAuth list |

5. **Discord app:** create one at <https://discord.com/developers/applications>, then add the
   redirect URI `https://<your-domain>/discord/callback`.
6. Open `https://<your-domain>/discord/connect` once and authorize.
7. **Alphabot webhook:** in your Alphabot profile developer section, set the webhook URL to
   `https://<your-domain>/alphabot`. Alphabot sends `webhook:test`; a 200 saves it.

Check `https://<your-domain>/health` at any time for uptime, queue depth, remaining GET budget,
and whether Discord is connected.

## Tuning

Edit `config.json` and redeploy. The defaults skip raffles that need a CAPTCHA, an NFT holding,
a token or ETH balance, or a Discord server you have not joined.

- `entry.dryRun` — log decisions without registering
- `entry.allowedBlockchains` — e.g. `["ethereum", "solana"]`, empty means all
- `entry.excludeKeywords` — case-insensitive substrings matched against the raffle name
- `entry.minWinnerCount` — ignore raffles with very few winners
- `discord.requireGuildWhitelist` — set `false` to attempt Discord-gated raffles regardless

## Limitations

- CAPTCHA-gated raffles are never entered.
- While the container is asleep or redeploying, `raffle:active` events are lost. The poller
  catches most of them afterwards, except Discord-gated ones, whose required server cannot be
  identified from the list endpoint without spending the scarce GET budget.
````

- [ ] **Step 6: Run the whole verification suite**

```bash
npx tsc --noEmit
npx vitest run --coverage
```

Expected: type check clean, all tests pass, coverage at or above the 80% threshold configured in
`vitest.config.ts`.

- [ ] **Step 7: Smoke test the server locally**

```bash
npm run build
DATA_DIR=./data ALPHABOT_API_KEY=dummy PORT=3000 node dist/index.js --dry-run
```

In a second terminal:

```bash
curl -s localhost:3000/health
```

Expected: JSON with `"ok":true`. Then confirm an unsigned webhook is answered `200` and ignored:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/alphabot \
  -H 'content-type: application/json' -d '{"event":"raffle:active","timestamp":1,"hash":"x"}'
```

Expected: `200`, and a log line saying the hash did not verify.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts Dockerfile .dockerignore railway.json README.md
git commit -m "feat: service bootstrap, docker image, railway config and readme"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| 2 — auth, base URL, rate limits | Task 2 (`client.ts`, token bucket), Task 1 (`intervalSeconds` floor) |
| 2 — webhook HMAC contract | Task 4 (`verify.ts`), Task 12 (always answers 200) |
| 3 — architecture, two producers one queue | Tasks 9, 11, 12 |
| 4 — every module in the table | Tasks 1–13 |
| 5 — all 13 filter rules plus poller fallback | Task 6 |
| 6 — config schema and env table | Task 1, Task 13 (README) |
| 7 — error handling table | Task 2 (401/429/5xx), Task 9 (400, auth cutoff), Task 5 (store failure), Task 7 (notify failure) |
| 8 — security | Task 1 (redaction), Task 4 (timing-safe), Task 8 (signed state), Task 13 (`.dockerignore`, `.gitignore`) |
| 9 — testing targets | Every task ships its tests; coverage threshold enforced in `vitest.config.ts` |
| 10 — Railway deployment | Task 13 |

**Placeholder scan:** no TBDs; every code step contains complete, runnable code. Step 2 of Task 13
is an explicit refactor of the code shown in Step 1, not a placeholder.

**Type consistency:** `RegisterOutcome` is produced in Task 3 and consumed unchanged in Tasks 7
and 9. `SkipReason` is produced in Task 6 and consumed in Task 7. `getGuildIds()` returns
`Promise<ReadonlySet<string>>` in Task 8 and is consumed with `await` in Task 9. `EntryQueue.submit`
takes `(raffle, source)` in Task 9 and is called that way in Tasks 10 and 11. `store.has` /
`store.record` signatures match between Tasks 5 and 9.
