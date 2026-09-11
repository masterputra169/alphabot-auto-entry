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
  poll: {
    enabled: true, intervalSeconds: 600, pageSize: 50,
    resolveDiscordRequirements: true, maxResolvesPerCycle: 10,
  },
  entry: {
    delayMs: 700, dryRun: false, skipCaptcha: true, skipNftHolding: true,
    skipTokenGated: true, allowedBlockchains: [], excludeKeywords: [], minWinnerCount: 0,
    retryHours: 6,
  },
  discord: {
    requireGuildWhitelist: true, guildMatchMode: 'any',
    guildIds: [], refreshHours: 6,
  },
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

  it('takes the mint address from MINT_ADDRESS so it need not sit in git', () => {
    const cfg = loadConfig({
      configPath: writeConfig(VALID),
      env: { ALPHABOT_API_KEY: 'k', MINT_ADDRESS: '0xabc' },
    });
    expect(cfg.submission.mintAddress).toBe('0xabc');
  });

  it('lets MINT_ADDRESS override a mint address already in the config file', () => {
    const withWallet = {
      ...VALID,
      submission: { ...VALID.submission, mintAddress: '0xfromfile' },
    };
    const cfg = loadConfig({
      configPath: writeConfig(withWallet),
      env: { ALPHABOT_API_KEY: 'k', MINT_ADDRESS: '0xfromenv' },
    });
    expect(cfg.submission.mintAddress).toBe('0xfromenv');
  });

  it('keeps the config file mint address when MINT_ADDRESS is blank', () => {
    const withWallet = {
      ...VALID,
      submission: { ...VALID.submission, mintAddress: '0xfromfile' },
    };
    const cfg = loadConfig({
      configPath: writeConfig(withWallet),
      env: { ALPHABOT_API_KEY: 'k', MINT_ADDRESS: '  ' },
    });
    expect(cfg.submission.mintAddress).toBe('0xfromfile');
  });

  it('treats blank optional env values as null', () => {
    const cfg = loadConfig({
      configPath: writeConfig(VALID),
      env: { ALPHABOT_API_KEY: 'k', DISCORD_CLIENT_ID: '   ', RAFFLE_PASSWORD: '' },
    });
    expect(cfg.env.discordClientId).toBeNull();
    expect(cfg.env.rafflePassword).toBeNull();
  });

  it('reads the win webhook url from the environment', () => {
    const cfg = loadConfig({
      configPath: writeConfig(VALID),
      env: { ALPHABOT_API_KEY: 'k', DISCORD_WIN_WEBHOOK_URL: 'https://discord.com/api/webhooks/w' },
    });
    expect(cfg.env.winWebhookUrl).toBe('https://discord.com/api/webhooks/w');
  });

  it('leaves the win webhook url null so wins fall back to the main channel', () => {
    const cfg = loadConfig({ configPath: writeConfig(VALID), env: { ALPHABOT_API_KEY: 'k' } });
    expect(cfg.env.winWebhookUrl).toBeNull();
  });

  it('reads the win mention from the environment', () => {
    const cfg = loadConfig({
      configPath: writeConfig(VALID),
      env: { ALPHABOT_API_KEY: 'k', DISCORD_WIN_MENTION: '@everyone' },
    });
    expect(cfg.env.winMention).toBe('@everyone');
  });
});
