import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AlphabotClient } from '../api/client.js';
import type { AppConfig } from '../config.js';
import type { BlockerReport } from '../core/blocker-report.js';
import type { EntryQueue } from '../core/entry-queue.js';
import type { EntryStore } from '../core/store.js';
import {
  buildAuthorizeUrl, createState, exchangeCode, verifyState, type OAuthConfig,
} from '../discord/oauth.js';
import type { GuildDirectory } from '../discord/guilds.js';
import { log } from '../logger.js';
import type { WinAnnouncer } from '../notify/win-announcer.js';
import { handleEvent } from './handlers.js';
import { verifyWebhook } from './verify.js';

export interface ServerDeps {
  config: AppConfig;
  queue: Pick<EntryQueue, 'submit' | 'depth'>;
  wins: Pick<WinAnnouncer, 'announce'>;
  guilds: Pick<GuildDirectory, 'connected' | 'lastRefreshedAt' | 'saveTokens'>;
  store: Pick<
    EntryStore,
    'size' | 'enteredCount' | 'wonCount' | 'blockedByReason' | 'blockedByTask'
  >;
  client: Pick<AlphabotClient, 'budgetRemaining'>;
  blockers?: Pick<BlockerReport, 'ranked' | 'pending'>;
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

/**
 * True when the request carries the admin token, as `?token=` or as an
 * `Authorization: Bearer` header. With no token configured nothing matches.
 */
function isAdmin(req: IncomingMessage, url: URL, adminToken: string | null): boolean {
  if (!adminToken) return false;
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  const given = url.searchParams.get('token') ?? bearer;
  if (!given) return false;
  // Hashing first gives equal-length buffers, so the compare leaks no length.
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(adminToken));
}

export function createServer(deps: ServerDeps): Server {
  const { config } = deps;
  const apiKey = config.env.alphabotApiKey;

  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      const uptimeSeconds = Math.round((Date.now() - deps.startedAt) / 1000);
      // The platform health check only needs a 200. Stats stay owner-only.
      if (!isAdmin(req, url, config.env.adminToken)) {
        send(res, 200, JSON.stringify({ ok: true, uptimeSeconds }), 'application/json');
        return;
      }
      send(res, 200, JSON.stringify({
        ok: true,
        uptimeSeconds,
        queueDepth: deps.queue.depth,
        attempted: deps.store.size,
        entered: deps.store.enteredCount,
        won: deps.store.wonCount,
        blockedBy: deps.store.blockedByReason(),
        blockedByTask: deps.store.blockedByTask(),
        blockingServers: deps.blockers?.ranked ?? [],
        blockingServersPending: deps.blockers?.pending ?? 0,
        getBudgetRemaining: deps.client.budgetRemaining,
        discordConnected: deps.guilds.connected,
        discordRefreshedAt: deps.guilds.lastRefreshedAt,
        dryRun: config.entry.dryRun,
      }), 'application/json');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/alphabot') {
      // Alphabot requires a fast 200 for every delivery, valid or not, so the
      // response goes out before any verification or handling work happens.
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

          void handleEvent(parsed, { queue: deps.queue, wins: deps.wins })
            .catch((error: Error) => log.error('Webhook handler failed', {
              message: error.message,
            }));
        })
        .catch(() => send(res, 200, ''));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/discord/connect') {
      // Without this anyone who finds the URL could link their own Discord
      // account and overwrite the owner's tokens.
      if (!config.env.adminToken) {
        send(res, 503, 'Set ADMIN_TOKEN, then open /discord/connect?token=<ADMIN_TOKEN>.');
        return;
      }
      if (!isAdmin(req, url, config.env.adminToken)) {
        send(res, 403, 'Forbidden');
        return;
      }
      const oauth = oauthConfig(config);
      if (!oauth) {
        send(res, 503, 'Discord OAuth is not configured. Set DISCORD_CLIENT_ID, '
          + 'DISCORD_CLIENT_SECRET and PUBLIC_BASE_URL.');
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
        .then(() => send(res, 200,
          'Discord connected. Your server list will refresh automatically.'))
        .catch((error: Error) => {
          log.error('Discord OAuth callback failed', { message: error.message });
          send(res, 502, 'Could not complete the Discord connection. Check the logs.');
        });
      return;
    }

    send(res, 404, 'Not found');
  });
}
