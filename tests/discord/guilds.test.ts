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
const future = () => Date.now() + 30 * 86_400_000;

describe('fetchAllGuilds', () => {
  it('paginates until a short page is returned', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(guilds(200)))
      .mockResolvedValueOnce(json(guilds(5, 200)));

    const all = await fetchAllGuilds('token', fetchImpl as unknown as typeof fetch);

    expect(all).toHaveLength(205);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [secondUrl] = fetchImpl.mock.calls[1] as unknown as [string];
    expect(secondUrl).toContain('after=g199');
  });

  it('stops after a single short page', async () => {
    const fetchImpl = vi.fn(async () => json(guilds(3)));
    await expect(fetchAllGuilds('t', fetchImpl as unknown as typeof fetch))
      .resolves.toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('sends the bearer token', async () => {
    const fetchImpl = vi.fn(async () => json(guilds(1)));
    await fetchAllGuilds('my-token', fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
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
    expect(dir.lastRefreshedAt).toBeNull();
    expect([...(await dir.getGuildIds())]).toEqual(['manual-1']);
  });

  it('merges oauth guilds with manual ids after saving tokens', async () => {
    const fetchImpl = vi.fn(async () => json([{ id: 'g1', name: 'One' }]));
    const dir = await GuildDirectory.open(tempDir(), {
      manualGuildIds: ['manual-1'], oauth, refreshHours: 6,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await dir.saveTokens({ accessToken: 'at', refreshToken: 'rt', expiresAt: future() });
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
    await dir.saveTokens({ accessToken: 'at', refreshToken: 'rt', expiresAt: future() });
    await dir.getGuildIds();
    await dir.getGuildIds();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('refreshes an access token that is close to expiring', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 604800 }))
      .mockResolvedValueOnce(json([{ id: 'g1', name: 'One' }]));
    const dir = await GuildDirectory.open(tempDir(), {
      manualGuildIds: [], oauth, refreshHours: 6,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await dir.saveTokens({ accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() + 1000 });

    const [tokenUrl] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(tokenUrl).toContain('/oauth2/token');
    expect([...(await dir.getGuildIds())]).toEqual(['g1']);
  });

  it('persists tokens and the guild list across reopen', async () => {
    const path = tempDir();
    const fetchImpl = vi.fn(async () => json([{ id: 'g1', name: 'One' }]));
    const first = await GuildDirectory.open(path, {
      manualGuildIds: [], oauth, refreshHours: 6,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await first.saveTokens({ accessToken: 'at', refreshToken: 'rt', expiresAt: future() });

    const second = await GuildDirectory.open(path, {
      manualGuildIds: [], oauth, refreshHours: 6,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(second.connected).toBe(true);
    expect(second.lastRefreshedAt).not.toBeNull();
    expect([...(await second.getGuildIds())]).toEqual(['g1']);
  });

  it('keeps serving the cached list when a refresh fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json([{ id: 'g1', name: 'One' }]))
      .mockRejectedValue(new Error('discord down'));
    const dir = await GuildDirectory.open(tempDir(), {
      manualGuildIds: [], oauth, refreshHours: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await dir.saveTokens({ accessToken: 'at', refreshToken: 'rt', expiresAt: future() });
    expect([...(await dir.getGuildIds())]).toEqual(['g1']);
  });
});
