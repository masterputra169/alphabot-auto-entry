import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { log } from '../logger.js';
import { DISCORD_API, refreshTokens, type OAuthConfig, type TokenSet } from './oauth.js';

const FILE_NAME = 'discord.json';
const PAGE_SIZE = 200;
const REFRESH_WHEN_EXPIRING_WITHIN_MS = 86_400_000;

export interface Guild {
  id: string;
  name: string;
}

/** Reads the owner's guild list via OAuth2 `guilds` scope, paginating past 200. */
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
      this.refreshing ??= this.refresh().finally(() => {
        this.refreshing = null;
      });
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
      if (this.opts.oauth && active.expiresAt - Date.now() < REFRESH_WHEN_EXPIRING_WITHIN_MS) {
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
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(this.state, null, 2), 'utf8');
      await rename(tmpPath, this.filePath);
    } catch (error) {
      log.warn('Could not persist discord.json', { message: (error as Error).message });
    }
  }
}
