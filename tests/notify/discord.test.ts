import { describe, expect, it, vi } from 'vitest';
import { DiscordNotifier } from '../../src/notify/discord.js';
import type { RaffleForList } from '../../src/api/types.js';

const raffle = {
  _id: '1', slug: 'cool-raffle', name: 'Cool Raffle', status: 'active',
  winnerCount: 25, blockchain: 'ethereum',
} as RaffleForList;

const URL_ = 'https://discord.com/api/webhooks/x';
const ok = () => new Response(null, { status: 204 });

const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>) =>
  JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);

describe('DiscordNotifier', () => {
  it('posts an embed when a raffle is entered', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const notifier = new DiscordNotifier(URL_, fetchImpl as unknown as typeof fetch);

    await notifier.entered(raffle, { success: true, entries: 3, reason: null, resultMd: null });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(URL_);
    const payload = bodyOf(fetchImpl);
    expect(payload.embeds[0].title).toContain('Cool Raffle');
    expect(payload.embeds[0].url).toBe('https://www.alphabot.app/cool-raffle');
    expect(JSON.stringify(payload)).toContain('"3"');
  });

  it('omits the entries field when the count is unknown', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const notifier = new DiscordNotifier(URL_, fetchImpl as unknown as typeof fetch);
    await notifier.entered(raffle, { success: true, entries: null, reason: null, resultMd: null });
    const names = bodyOf(fetchImpl).embeds[0].fields.map((f: { name: string }) => f.name);
    expect(names).not.toContain('Entries');
    expect(names).toContain('Winners');
  });

  it('does nothing when no webhook url is configured', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const notifier = new DiscordNotifier(null, fetchImpl as unknown as typeof fetch);
    await notifier.entered(raffle, { success: true, entries: 1, reason: null, resultMd: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws when discord rejects the webhook', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const notifier = new DiscordNotifier(URL_, fetchImpl as unknown as typeof fetch);
    await expect(notifier.failed(raffle, 'boom')).resolves.toBeUndefined();
  });

  it('never throws when the network fails', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    const notifier = new DiscordNotifier(URL_, fetchImpl as unknown as typeof fetch);
    await expect(notifier.fatal('bad key')).resolves.toBeUndefined();
  });

  it('truncates very long failure messages', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const notifier = new DiscordNotifier(URL_, fetchImpl as unknown as typeof fetch);
    await notifier.failed(raffle, 'x'.repeat(5000));
    expect(bodyOf(fetchImpl).embeds[0].description).toHaveLength(1000);
  });

  it('does not post for skips', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const notifier = new DiscordNotifier(URL_, fetchImpl as unknown as typeof fetch);
    await notifier.skipped(raffle, 'captcha_required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('logs the missing servers when a skip carries detail', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const notifier = new DiscordNotifier(null);
    await notifier.skipped(raffle, 'discord_guild_not_joined', 'Snailies (123)');
    expect(spy.mock.calls[0]?.join(' ')).toContain('Snailies (123)');
    spy.mockRestore();
  });

  it('does not post an expected rejection, only logs it', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const notifier = new DiscordNotifier(URL_, fetchImpl as unknown as typeof fetch);
    await notifier.rejected(raffle, 'One or more tasks incomplete.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts a win notification with the mint address', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const notifier = new DiscordNotifier(URL_, fetchImpl as unknown as typeof fetch);
    await notifier.won(raffle, { mintAddress: '0xabc' });
    expect(JSON.stringify(bodyOf(fetchImpl))).toContain('0xabc');
  });

  it('posts a win notification even without an entry payload', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const notifier = new DiscordNotifier(URL_, fetchImpl as unknown as typeof fetch);
    await notifier.won(raffle, undefined);
    expect(bodyOf(fetchImpl).embeds[0].title).toContain('You won');
  });
});
