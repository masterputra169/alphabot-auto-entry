import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer, type ServerDeps } from '../../src/webhook/server.js';
import type { AppConfig } from '../../src/config.js';

const KEY = 'server-test-key';

const config = (envOver: Partial<AppConfig['env']> = {}): AppConfig => ({
  poll: {
    enabled: false, intervalSeconds: 600, pageSize: 50,
    resolveDiscordRequirements: true, maxResolvesPerCycle: 10,
  },
  entry: {
    delayMs: 700, dryRun: false, skipCaptcha: true, skipNftHolding: true,
    skipTokenGated: true, allowedBlockchains: [], excludeKeywords: [], minWinnerCount: 0,
  },
  discord: {
    requireGuildWhitelist: true, guildMatchMode: 'any',
    guildIds: [], refreshHours: 6,
  },
  submission: { mintAddress: null, discordId: null, twitterId: null, telegramId: null },
  env: {
    alphabotApiKey: KEY, port: 0, dataDir: './data', publicBaseUrl: 'https://app.test',
    discordClientId: 'cid', discordClientSecret: 'csecret',
    notifyWebhookUrl: null, rafflePassword: null, ...envOver,
  },
});

let server: Server | null = null;

function start(over: Partial<ServerDeps> = {}) {
  const submit = vi.fn();
  const saveTokens = vi.fn(async () => {});
  server = createServer({
    config: config(),
    queue: { submit, depth: 0 },
    notifier: { won: vi.fn(async () => {}) } as never,
    guilds: { connected: true, lastRefreshedAt: 1, saveTokens } as never,
    store: { size: 3 },
    client: { budgetRemaining: 27 },
    startedAt: Date.now(),
    ...over,
  } as ServerDeps);
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, submit, saveTokens };
}

afterEach(() => {
  server?.close();
  server = null;
});

function signedBody(event: string, data: unknown = {}) {
  const timestamp = Date.now();
  const hash = createHmac('sha256', KEY).update(`${event}\n${timestamp}`).digest('hex');
  return JSON.stringify({ event, timestamp, hash, data });
}

const settle = () => new Promise((r) => setTimeout(r, 30));

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
    await settle();
    expect(submit).toHaveBeenCalledOnce();
  });

  it('answers 200 to a signed webhook:test so alphabot saves the url', async () => {
    const { base } = start();
    const response = await fetch(`${base}/alphabot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: signedBody('webhook:test'),
    });
    expect(response.status).toBe(200);
  });

  it('answers 200 but ignores a badly signed webhook', async () => {
    const { base, submit } = start();
    const response = await fetch(`${base}/alphabot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'raffle:active', timestamp: 1, hash: 'nope', data: {} }),
    });
    expect(response.status).toBe(200);
    await settle();
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
    expect(location.searchParams.get('redirect_uri')).toBe('https://app.test/discord/callback');
  });

  it('reports 503 on /discord/connect when oauth is not configured', async () => {
    const { base } = start({ config: config({ discordClientId: null }) });
    const response = await fetch(`${base}/discord/connect`, { redirect: 'manual' });
    expect(response.status).toBe(503);
  });

  it('rejects a callback with an invalid state', async () => {
    const { base } = start();
    const response = await fetch(`${base}/discord/callback?code=x&state=bogus`);
    expect(response.status).toBe(400);
  });

  it('rejects a callback with no code', async () => {
    const { base } = start();
    expect((await fetch(`${base}/discord/callback`)).status).toBe(400);
  });

  it('saves tokens when the callback succeeds', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'at', refresh_token: 'rt', expires_in: 604800,
    }), { status: 200 }));

    // Reuse the server's own state generator by hitting /discord/connect first.
    const { base, saveTokens } = start({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const redirect = await fetch(`${base}/discord/connect`, { redirect: 'manual' });
    const state = new URL(redirect.headers.get('location') as string).searchParams.get('state');

    const response = await fetch(`${base}/discord/callback?code=abc&state=${state}`);

    expect(response.status).toBe(200);
    expect(saveTokens).toHaveBeenCalledOnce();
  });

  it('reports 502 when discord rejects the code exchange', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    const { base } = start({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const redirect = await fetch(`${base}/discord/connect`, { redirect: 'manual' });
    const state = new URL(redirect.headers.get('location') as string).searchParams.get('state');

    const response = await fetch(`${base}/discord/callback?code=bad&state=${state}`);
    expect(response.status).toBe(502);
  });

  it('returns 404 for unknown routes', async () => {
    const { base } = start();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
