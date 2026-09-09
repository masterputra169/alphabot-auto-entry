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

  it('rejects a state issued in the future', () => {
    const state = createState('hmac-secret', 5000);
    expect(verifyState(state, 'hmac-secret', 1000)).toBe(false);
  });

  it('rejects malformed state', () => {
    expect(verifyState('garbage', 'hmac-secret', 1000)).toBe(false);
    expect(verifyState('notanumber.abcdef', 'hmac-secret', 1000)).toBe(false);
    expect(verifyState('1000.short', 'hmac-secret', 1000)).toBe(false);
  });
});

describe('exchangeCode', () => {
  it('posts form encoded credentials and maps the token set', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'at', refresh_token: 'rt', expires_in: 604800,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const tokens = await exchangeCode(cfg, 'the-code', fetchImpl as unknown as typeof fetch, 1000);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/v10/oauth2/token');
    expect((init.headers as Record<string, string>)['content-type'])
      .toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(tokens).toEqual({
      accessToken: 'at', refreshToken: 'rt', expiresAt: 1000 + 604800 * 1000,
    });
  });

  it('throws a readable error when discord rejects the code', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(exchangeCode(cfg, 'bad', fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/invalid_grant/);
  });

  it('throws when the response omits the tokens', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"access_token":"only"}', { status: 200 }));
    await expect(exchangeCode(cfg, 'x', fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/did not include the expected tokens/);
  });
});

describe('refreshTokens', () => {
  it('uses the refresh_token grant', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'at2', refresh_token: 'rt2', expires_in: 100,
    }), { status: 200 }));
    await refreshTokens(cfg, 'old-rt', fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-rt');
  });
});
