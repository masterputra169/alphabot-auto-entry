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

/** Signed, self-expiring CSRF token; no server-side session needed. */
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
