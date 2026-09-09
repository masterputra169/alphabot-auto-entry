import { describe, expect, it, vi } from 'vitest';
import {
  getRaffleWithRequirements, listActiveRaffles, register,
} from '../../src/api/raffles.js';
import { ApiError, type AlphabotClient } from '../../src/api/client.js';

function fakeClient(over: Record<string, unknown>): AlphabotClient {
  return { get: vi.fn(), post: vi.fn(), budgetRemaining: 28, ...over } as unknown as AlphabotClient;
}

describe('listActiveRaffles', () => {
  it('requests active unregistered raffles sorted by ending soonest', async () => {
    const get = vi.fn(async () => ({ raffles: [{ slug: 'a' }], finalPage: true }));
    const client = fakeClient({ get });

    const raffles = await listActiveRaffles(client, { pageSize: 50 });

    expect(raffles).toEqual([{ slug: 'a' }]);
    expect(get).toHaveBeenCalledWith('raffles', {
      status: 'active',
      filter: 'unregistered',
      sort: 'ending',
      sortDir: 1,
      pageSize: 50,
      pageNum: 0,
    });
  });

  it('defaults to a page size of 50', async () => {
    const get = vi.fn(async () => ({ raffles: [] }));
    await listActiveRaffles(fakeClient({ get }));
    expect(get).toHaveBeenCalledWith('raffles', expect.objectContaining({ pageSize: 50 }));
  });

  it('returns an empty array when the API returns no data', async () => {
    const client = fakeClient({ get: vi.fn(async () => undefined) });
    await expect(listActiveRaffles(client)).resolves.toEqual([]);
  });
});

describe('getRaffleWithRequirements', () => {
  it('asks for the requirements and unwraps the raffle', async () => {
    const get = vi.fn(async () => ({
      raffle: { slug: 'cool', discordServerRoles: [{ id: 'guild-a' }] },
    }));

    const raffle = await getRaffleWithRequirements(fakeClient({ get }), 'cool');

    expect(get).toHaveBeenCalledWith('raffles/cool', { requirements: 'true' });
    expect(raffle?.discordServerRoles).toEqual([{ id: 'guild-a' }]);
  });

  it('url-encodes the slug', async () => {
    const get = vi.fn(async () => ({ raffle: {} }));
    await getRaffleWithRequirements(fakeClient({ get }), 'a/b c');
    expect(get).toHaveBeenCalledWith('raffles/a%2Fb%20c', { requirements: 'true' });
  });

  it('returns undefined when the api sends no raffle', async () => {
    const get = vi.fn(async () => undefined);
    await expect(getRaffleWithRequirements(fakeClient({ get }), 'gone')).resolves.toBeUndefined();
  });
});

describe('register', () => {
  it('omits undefined submission fields', async () => {
    const post = vi.fn(async () => ({ validation: { success: true, entries: 3 } }));
    const client = fakeClient({ post });

    const outcome = await register(client, { slug: 'cool-raffle', discordId: '42' });

    expect(post).toHaveBeenCalledWith('register', { slug: 'cool-raffle', discordId: '42' });
    expect(outcome).toEqual({ success: true, entries: 3, reason: null, resultMd: null });
  });

  it('passes every provided submission override', async () => {
    const post = vi.fn(async () => ({ validation: { success: true } }));
    await register(fakeClient({ post }), {
      slug: 's', mintAddress: '0x1', discordId: 'd', twitterId: 't', telegramId: 'g',
    });
    expect(post).toHaveBeenCalledWith('register', {
      slug: 's', mintAddress: '0x1', discordId: 'd', twitterId: 't', telegramId: 'g',
    });
  });

  it('surfaces the failure reason from validation', async () => {
    const post = vi.fn(async () => ({
      resultMd: 'You are not in the server',
      validation: { success: false, reason: 'discord_invalid' },
    }));
    const outcome = await register(fakeClient({ post }), { slug: 's' });
    expect(outcome.success).toBe(false);
    expect(outcome.reason).toBe('discord_invalid');
    expect(outcome.resultMd).toBe('You are not in the server');
  });

  it('treats a missing validation block as success when the call resolved', async () => {
    const post = vi.fn(async () => ({ resultMd: 'Entered!' }));
    const outcome = await register(fakeClient({ post }), { slug: 's' });
    expect(outcome.success).toBe(true);
    expect(outcome.entries).toBeNull();
  });

  it('unwraps a declined registration into an outcome, keeping the machine reason', async () => {
    const post = vi.fn().mockRejectedValue(new ApiError(
      'Alphabot request failed: Opportunity has ended', 200, true,
      { validation: { success: false, reason: 'opportunity_ended', entries: 0 },
        resultMd: 'Opportunity has ended' },
    ));

    const outcome = await register(fakeClient({ post }), { slug: 's' });

    expect(outcome.success).toBe(false);
    expect(outcome.reason).toBe('opportunity_ended');
    expect(outcome.resultMd).toBe('Opportunity has ended');
  });

  it('falls back to the error message when a decline carries no validation', async () => {
    const post = vi.fn().mockRejectedValue(new ApiError('nope', 200, true, undefined));
    const outcome = await register(fakeClient({ post }), { slug: 's' });
    expect(outcome).toMatchObject({ success: false, reason: 'nope' });
  });

  it('rethrows an error whose outcome is unknown', async () => {
    const post = vi.fn().mockRejectedValue(new ApiError('server error', 500, false));
    await expect(register(fakeClient({ post }), { slug: 's' })).rejects.toBeInstanceOf(ApiError);
  });

  it('tolerates an entirely empty response', async () => {
    const post = vi.fn(async () => undefined);
    await expect(register(fakeClient({ post }), { slug: 's' })).resolves.toEqual({
      success: true, entries: null, reason: null, resultMd: null,
    });
  });
});
