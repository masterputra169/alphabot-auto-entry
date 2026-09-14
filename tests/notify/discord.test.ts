import { describe, expect, it, vi } from 'vitest';
import { DiscordNotifier, type NotifierOptions } from '../../src/notify/discord.js';
import type { RaffleForList } from '../../src/api/types.js';

const raffle = {
  _id: '1', slug: 'cool-raffle', name: 'Cool Raffle', status: 'active',
  winnerCount: 25, blockchain: 'ethereum',
} as RaffleForList;

const URL_ = 'https://discord.com/api/webhooks/x';
const WIN_URL = 'https://discord.com/api/webhooks/wins';
const ok = () => new Response(null, { status: 204 });

/** A notifier whose fetch is a spy, with the main channel configured by default. */
function make(over: Partial<NotifierOptions> = {}) {
  const fetchImpl = vi.fn(async () => ok());
  const notifier = new DiscordNotifier({
    webhookUrl: URL_,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    // Retries and pacing are the sender's job and are tested there; here they
    // only need to not cost the suite real seconds.
    delivery: { sleep: async () => {}, minIntervalMs: 0 },
    ...over,
  });
  return { notifier, fetchImpl };
}

const callOf = (fetchImpl: ReturnType<typeof vi.fn>) =>
  fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

const urlOf = (fetchImpl: ReturnType<typeof vi.fn>) => callOf(fetchImpl)[0];

const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>) =>
  JSON.parse(callOf(fetchImpl)[1].body as string);

describe('DiscordNotifier', () => {
  it('posts an embed when a raffle is entered', async () => {
    const { notifier, fetchImpl } = make();

    await notifier.entered(raffle, { success: true, entries: 3, reason: null, resultMd: null });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(urlOf(fetchImpl)).toBe(URL_);
    const payload = bodyOf(fetchImpl);
    expect(payload.embeds[0].title).toContain('Cool Raffle');
    expect(payload.embeds[0].url).toBe('https://www.alphabot.app/cool-raffle');
    expect(JSON.stringify(payload)).toContain('"3"');
  });

  it('omits the entries field when the count is unknown', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.entered(raffle, { success: true, entries: null, reason: null, resultMd: null });
    const names = bodyOf(fetchImpl).embeds[0].fields.map((f: { name: string }) => f.name);
    expect(names).not.toContain('Entries');
    expect(names).toContain('Winners');
  });

  it('does nothing when no webhook url is configured', async () => {
    const { notifier, fetchImpl } = make({ webhookUrl: null });
    await notifier.entered(raffle, { success: true, entries: 1, reason: null, resultMd: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws when discord rejects the webhook', async () => {
    const { notifier } = make({
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(notifier.failed(raffle, 'boom')).resolves.toBe(false);
  });

  it('never throws when the network fails', async () => {
    const { notifier } = make({
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    await expect(notifier.fatal('bad key')).resolves.toBe(false);
  });

  it('truncates very long failure messages', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.failed(raffle, 'x'.repeat(5000));
    expect(bodyOf(fetchImpl).embeds[0].description).toHaveLength(1000);
  });

  it('does not post for skips', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.skipped(raffle, 'captcha_required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('logs the missing servers when a skip carries detail', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { notifier } = make({ webhookUrl: null });
    await notifier.skipped(raffle, 'discord_guild_not_joined', 'Snailies (123)');
    expect(spy.mock.calls[0]?.join(' ')).toContain('Snailies (123)');
    spy.mockRestore();
  });

  it('does not post an expected rejection, only logs it', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.rejected(raffle, 'One or more tasks incomplete.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts a win notification with the mint address', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.won(raffle, { mintAddress: '0xabc' });
    expect(JSON.stringify(bodyOf(fetchImpl))).toContain('0xabc');
  });

  it('posts a win notification even without an entry payload', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.won(raffle, undefined);
    expect(bodyOf(fetchImpl).embeds[0].title).toContain('Won: Cool Raffle');
  });

  it('sends a win to the dedicated win channel', async () => {
    const { notifier, fetchImpl } = make({ winWebhookUrl: WIN_URL });
    await notifier.won(raffle, undefined);
    expect(urlOf(fetchImpl)).toBe(WIN_URL);
  });

  it('falls back to the main channel when no win channel is configured', async () => {
    const { notifier, fetchImpl } = make({ winWebhookUrl: null });
    await notifier.won(raffle, undefined);
    expect(urlOf(fetchImpl)).toBe(URL_);
  });

  it('keeps ordinary notifications on the main channel when a win channel exists', async () => {
    const { notifier, fetchImpl } = make({ winWebhookUrl: WIN_URL });
    await notifier.entered(raffle, { success: true, entries: 1, reason: null, resultMd: null });
    expect(urlOf(fetchImpl)).toBe(URL_);
  });

  it('sends a win to the win channel even when the main channel is unset', async () => {
    const { notifier, fetchImpl } = make({ webhookUrl: null, winWebhookUrl: WIN_URL });
    await notifier.won(raffle, undefined);
    expect(urlOf(fetchImpl)).toBe(WIN_URL);
  });

  it('does nothing on a win when neither channel is configured', async () => {
    const { notifier, fetchImpl } = make({ webhookUrl: null, winWebhookUrl: null });
    await notifier.won(raffle, undefined);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('pings with the configured mention so a win is not missed', async () => {
    const { notifier, fetchImpl } = make({ winWebhookUrl: WIN_URL, winMention: '@everyone' });
    await notifier.won(raffle, undefined);
    expect(bodyOf(fetchImpl).content).toBe('@everyone');
  });

  it('omits the mention content when none is configured', async () => {
    const { notifier, fetchImpl } = make({ winWebhookUrl: WIN_URL });
    await notifier.won(raffle, undefined);
    expect(bodyOf(fetchImpl).content).toBeUndefined();
  });

  it('does not ping on an ordinary notification', async () => {
    const { notifier, fetchImpl } = make({ winMention: '@everyone' });
    await notifier.failed(raffle, 'boom');
    expect(bodyOf(fetchImpl).content).toBeUndefined();
  });

  it('shows the chain, winner count and entry count on a win', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.won(raffle, { entries: 7 });
    const fields = bodyOf(fetchImpl).embeds[0].fields as { name: string; value: string }[];
    expect(fields.find((f) => f.name === 'Chain')?.value).toBe('ethereum');
    expect(fields.find((f) => f.name === 'Winners')?.value).toBe('25');
    expect(fields.find((f) => f.name === 'Your entries')?.value).toBe('7');
  });

  it('reports a delivered win, so the webhook may record it', async () => {
    const { notifier } = make({ winWebhookUrl: WIN_URL });
    await expect(notifier.won(raffle, undefined)).resolves.toBe(true);
  });

  it('reports an undelivered win, so alphabot’s redelivery can announce it', async () => {
    const { notifier } = make({
      winWebhookUrl: WIN_URL,
      fetchImpl: (async () => new Response('down', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(notifier.won(raffle, undefined)).resolves.toBe(false);
  });

  it('counts a win as delivered when no channel is configured at all', async () => {
    const { notifier } = make({ webhookUrl: null, winWebhookUrl: null });
    await expect(notifier.won(raffle, undefined)).resolves.toBe(true);
  });

  it('retries an entry alert that discord rate-limits', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ retry_after: 0.2 }), { status: 429 })
        : ok();
    });
    const { notifier } = make({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const sent = await notifier.entered(
      raffle,
      { success: true, entries: 1, reason: null, resultMd: null },
    );

    expect(sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('flushes queued alerts so a redeploy does not swallow them', async () => {
    const { notifier, fetchImpl } = make();

    void notifier.entered(raffle, { success: true, entries: 1, reason: null, resultMd: null });
    void notifier.failed(raffle, 'boom');
    await notifier.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('posts a digest naming the servers worth joining', async () => {
    const { notifier, fetchImpl } = make();

    await notifier.blockers([
      {
        id: 'g1',
        label: 'Habibi Alpha',
        raffles: 4,
        invite: 'https://discord.gg/abc',
        roles: [{ name: 'Circle', val: 1 }, { name: 'SUPER HABIBI', val: 10 }],
      },
    ], 293);

    const embed = bodyOf(fetchImpl).embeds[0];
    expect(embed.title).toContain('worth joining');
    const field = embed.fields[0];
    expect(field.name).toContain('Habibi Alpha');
    expect(field.name).toContain('4');
    // The cheapest role is the one that actually unblocks the raffles.
    expect(field.value).toContain('Circle');
    expect(field.value).not.toContain('SUPER HABIBI');
    expect(field.value).toContain('https://discord.gg/abc');
    expect(embed.description).toContain('293');
  });

  it('says so when plain membership is enough', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.blockers([
      { id: 'g1', label: 'Open Server', raffles: 1, invite: null, roles: [] },
    ], 0);
    expect(bodyOf(fetchImpl).embeds[0].fields[0].value).toContain('Membership');
  });

  it('stays quiet when nothing is blocking', async () => {
    const { notifier, fetchImpl } = make();
    await expect(notifier.blockers([], 0)).resolves.toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
