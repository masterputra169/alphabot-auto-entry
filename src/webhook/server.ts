import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
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
  store: Pick<EntryStore, 'size' | 'enteredCount' | 'blockedByReason'>;
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
        attempted: deps.store.size,
        entered: deps.store.enteredCount,
        blockedBy: deps.store.blockedByReason(),
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

          void handleEvent(parsed, { queue: deps.queue, notifier: deps.notifier })
            .catch((error: Error) => log.error('Webhook handler failed', {
              message: error.message,
            }));
        })
        .catch(() => send(res, 200, ''));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/discord/connect') {
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
