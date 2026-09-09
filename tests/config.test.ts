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

  it('throws a readable error when the config file is missing', () => {
    expect(() => loadConfig({
      configPath: join(mkdtempSync(join(tmpdir(), 'abcfg-')), 'nope.json'),
      env: { ALPHABOT_API_KEY: 'k' },
    })).toThrow(/Could not read config file/);
  });

  it('rejects a poll interval that would exhaust the GET budget', () => {
    const bad = { ...VALID, poll: { ...VALID.poll, intervalSeconds: 30 } };
    expect(() => loadConfig({ configPath: writeConfig(bad), env: { ALPHABOT_API_KEY: 'k' } }))
      .toThrow(/intervalSeconds/);
  });

  it('rejects a page size above the api maximum', () => {
    const bad = { ...VALID, poll: { ...VALID.poll, pageSize: 500 } };
    expect(() => loadConfig({ configPath: writeConfig(bad), env: { ALPHABOT_API_KEY: 'k' } }))
      .toThrow(/pageSize/);
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

  it('treats blank optional env values as null', () => {
    const cfg = loadConfig({
      configPath: writeConfig(VALID),
      env: { ALPHABOT_API_KEY: 'k', DISCORD_CLIENT_ID: '   ', RAFFLE_PASSWORD: '' },
    });
    expect(cfg.env.discordClientId).toBeNull();
    expect(cfg.env.rafflePassword).toBeNull();
  });
});
