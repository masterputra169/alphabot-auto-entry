import type { AlphabotClient } from './client.js';
import type { RafflesListData, RaffleForList, RegisterResponse } from './types.js';

export interface ListOptions {
  pageSize?: number;
  pageNum?: number;
}

export async function listActiveRaffles(
  client: AlphabotClient,
  opts: ListOptions = {},
): Promise<RaffleForList[]> {
  const data = await client.get<RafflesListData | undefined>('raffles', {
    status: 'active',
    filter: 'unregistered',
    sort: 'ending',
    sortDir: 1,
    pageSize: opts.pageSize ?? 50,
    pageNum: opts.pageNum ?? 0,
  });
  return data?.raffles ?? [];
}

export interface RegisterInput {
  slug: string;
  mintAddress?: string;
  discordId?: string;
  twitterId?: string;
  telegramId?: string;
}

export interface RegisterOutcome {
  success: boolean;
  entries: number | null;
  reason: string | null;
  resultMd: string | null;
}

export async function register(
  client: AlphabotClient,
  input: RegisterInput,
): Promise<RegisterOutcome> {
  const body: Record<string, string> = { slug: input.slug };
  for (const key of ['mintAddress', 'discordId', 'twitterId', 'telegramId'] as const) {
    const value = input[key];
    if (value !== undefined && value !== null) body[key] = value;
  }

  const data = await client.post<RegisterResponse | undefined>('register', body);
  const validation = data?.validation;

  return {
    success: validation?.success ?? true,
    entries: validation?.entries ?? null,
    reason: validation?.reason ?? null,
    resultMd: data?.resultMd ?? null,
  };
}
