import { readFileSync } from 'node:fs';
import { z } from 'zod';

const MIN_POLL_SECONDS = 120;

const fileSchema = z.object({
  poll: z.object({
    enabled: z.boolean(),
    intervalSeconds: z.number().int().min(
      MIN_POLL_SECONDS,
      `poll.intervalSeconds must be >= ${MIN_POLL_SECONDS} to stay inside the 30 GET/hour limit`,
    ),
    pageSize: z.number().int().min(1).max(50),
    resolveDiscordRequirements: z.boolean(),
    maxResolvesPerCycle: z.number().int().min(0).max(24),
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
    retryHours: z.number().min(0).max(168),
  }),
  discord: z.object({
    requireGuildWhitelist: z.boolean(),
    guildMatchMode: z.enum(['any', 'all']),
    guildIds: z.array(z.string()),
    refreshHours: z.number().min(0).max(168),
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

  // The wallet is per-deployment and config.json is committed, so env wins.
  const mintAddress = optional(env.MINT_ADDRESS) ?? file.submission.mintAddress;

  return Object.freeze({
    ...file,
    discord: { ...file.discord, guildIds },
    submission: { ...file.submission, mintAddress },
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
