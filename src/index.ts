import 'dotenv/config';
import { AlphabotClient } from './api/client.js';
import { loadConfig, type AppConfig } from './config.js';
import { BlockerReport } from './core/blocker-report.js';
import { EntryQueue } from './core/entry-queue.js';
import { Poller } from './core/poller.js';
import { EntryStore } from './core/store.js';
import { GuildDirectory } from './discord/guilds.js';
import type { OAuthConfig } from './discord/oauth.js';
import { log, registerSecret } from './logger.js';
import { DiscordNotifier } from './notify/discord.js';
import { WinAnnouncer } from './notify/win-announcer.js';
import { createServer } from './webhook/server.js';

function oauthFrom(config: AppConfig): OAuthConfig | null {
  const { discordClientId, discordClientSecret, publicBaseUrl } = config.env;
  if (!discordClientId || !discordClientSecret || !publicBaseUrl) return null;
  return {
    clientId: discordClientId,
    clientSecret: discordClientSecret,
    redirectUri: `${publicBaseUrl}/discord/callback`,
  };
}

async function main(): Promise<void> {
  const loaded = loadConfig();

  registerSecret(loaded.env.alphabotApiKey);
  registerSecret(loaded.env.discordClientSecret);
  registerSecret(loaded.env.notifyWebhookUrl);
  registerSecret(loaded.env.winWebhookUrl);
  registerSecret(loaded.env.rafflePassword);
  registerSecret(loaded.env.adminToken);

  const dryRun = process.argv.includes('--dry-run') || loaded.entry.dryRun;
  const config: AppConfig = dryRun
    ? { ...loaded, entry: { ...loaded.entry, dryRun: true } }
    : loaded;

  const client = new AlphabotClient({ apiKey: config.env.alphabotApiKey });
  const store = await EntryStore.open(config.env.dataDir);
  const notifier = new DiscordNotifier({
    webhookUrl: config.env.notifyWebhookUrl,
    winWebhookUrl: config.env.winWebhookUrl,
    winMention: config.env.winMention,
  });

  const guilds = await GuildDirectory.open(config.env.dataDir, {
    manualGuildIds: config.discord.guildIds,
    oauth: oauthFrom(config),
    refreshHours: config.discord.refreshHours,
  });

  if (config.discord.requireGuildWhitelist
      && !guilds.connected
      && config.discord.guildIds.length === 0) {
    log.warn(
      'No Discord guilds are known yet, so every Discord-gated raffle will be skipped. '
      + 'Visit /discord/connect to authorize, or set DISCORD_GUILD_IDS.',
    );
  }

  // Declared before the queue so onAuthError can stop it, assigned right after.
  let poller: Poller | null = null;

  const queue = new EntryQueue({
    config,
    client,
    store,
    notifier,
    guilds,
    onAuthError: () => poller?.stop(),
  });

  poller = new Poller({ config, client, queue, store });
  const blockers = new BlockerReport({ config, client, store });
  const wins = new WinAnnouncer({
    store,
    notifier,
    client,
    intervalSeconds: config.poll.intervalSeconds,
    reconcileHours: config.poll.reconcileWinsHours,
    pageSize: config.poll.pageSize,
  });

  const server = createServer({
    config,
    queue,
    wins,
    guilds,
    store,
    client,
    blockers,
    startedAt: Date.now(),
  });

  server.listen(config.env.port, () => {
    log.info(`Listening on port ${config.env.port}`, { dryRun });
    if (config.env.publicBaseUrl) {
      log.info(`Set the Alphabot webhook URL to ${config.env.publicBaseUrl}/alphabot`);
      if (!guilds.connected) {
        log.info(`Connect Discord at ${config.env.publicBaseUrl}/discord/connect`);
      }
    }
  });

  if (process.argv.includes('--once')) {
    await poller.runOnce();
    await queue.idle();
    await wins.retryPending();
    await notifier.flush();
    server.close();
    return;
  }

  poller.start();
  blockers.start();
  wins.start();
  // The store is rewritten whole on every attempt, so keeping it compact is
  // what keeps that cost flat as the weeks go by.
  const compaction = setInterval(() => {
    void store.prune();
  }, config.poll.intervalSeconds * 1000);
  compaction.unref();

  // Hundreds of raffles sit behind a few Discord servers, and that is the one
  // part of the yield only the owner can move. Sent on startup too, because a
  // weekly timer on a service that redeploys would never fire.
  const sendDigest = (): void => {
    const top = blockers.ranked.slice(0, config.notify.blockerDigestSize);
    void notifier.blockers(top, blockers.pending);
  };
  const digestHours = config.notify.blockerDigestHours;
  const digest = digestHours > 0
    ? setInterval(sendDigest, digestHours * 3_600_000)
    : null;
  digest?.unref();

  // These run once immediately; their timers only cover the cycles after that.
  void poller.runOnce()
    .then(() => blockers.refresh())
    .then(() => { if (digest) sendDigest(); });
  // A win delivered while the container was restarting is only findable by
  // asking, and a restart is exactly what just happened.
  void wins.retryPending().then(() => wins.reconcile());

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down`);
    poller?.stop();
    blockers.stop();
    wins.stop();
    clearInterval(compaction);
    if (digest) clearInterval(digest);
    // Stop taking new work before draining, or an alert raised during the
    // flush would not be among the ones waited for. Alerts are paced, so a
    // redeploy can catch some still queued, and losing those would be losing
    // the very notifications this bot exists to send.
    server.close();
    void notifier.flush().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: Error) => {
  log.error('Fatal startup error', { message: error.message });
  process.exit(1);
});
