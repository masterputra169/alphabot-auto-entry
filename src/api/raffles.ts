import { ApiError, type AlphabotClient } from './client.js';
import type {
  RafflesListData, RaffleForList, RaffleWithRequirements, RegisterResponse,
  ValidationResult,
} from './types.js';

export interface ListOptions {
  pageSize?: number;
  pageNum?: number;
}

interface SingleRaffleData {
  raffle: RaffleWithRequirements;
}

/**
 * Fetches one raffle including its full requirements — notably
 * `discordServerRoles`, which the list endpoint does not expose.
 *
 * Costs one request from the 30/hour GET budget, so callers must check
 * the client's remaining budget before looping over this.
 */
export async function getRaffleWithRequirements(
  client: AlphabotClient,
  slug: string,
): Promise<RaffleWithRequirements | undefined> {
  const data = await client.get<SingleRaffleData | undefined>(
    `raffles/${encodeURIComponent(slug)}`,
    { requirements: 'true' },
  );
  return data?.raffle;
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

/**
 * Raffles this account has won, straight from Alphabot.
 *
 * The `raffle:won` webhook is the fast path, but a delivery that arrives
 * while the container is restarting is simply gone — and a win nobody was
 * ever told about looks exactly like a win whose alert failed. This is the
 * only way to notice one after the fact. Costs one GET from the hourly budget.
 */
export async function listWonRaffles(
  client: AlphabotClient,
  opts: ListOptions = {},
): Promise<RaffleForList[]> {
  const data = await client.get<RafflesListData | undefined>('raffles', {
    filter: 'winners',
    sort: 'newest',
    sortDir: -1,
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
  /** Task categories Alphabot reported as outstanding, e.g. `['discord']`. */
  blockers: string[];
}

/** Validation flag to the task it represents. Only an explicit false counts. */
const TASK_FLAGS: [keyof ValidationResult, string][] = [
  ['discordValid', 'discord'],
  ['twitterValid', 'twitter'],
  ['telegramValid', 'telegram'],
  ['instagramValid', 'instagram'],
  ['tokensValid', 'tokens'],
  ['ethBalanceValid', 'eth_balance'],
  ['emailValid', 'email'],
  ['questionsValid', 'questions'],
  ['walletValid', 'wallet'],
];

export function blockersFrom(validation: ValidationResult | undefined): string[] {
  if (!validation) return [];
  return TASK_FLAGS.filter(([flag]) => validation[flag] === false).map(([, task]) => task);
}

function toOutcome(data: RegisterResponse | undefined, fallbackReason?: string): RegisterOutcome {
  const validation = data?.validation;
  return {
    success: validation?.success ?? true,
    entries: validation?.entries ?? null,
    reason: validation?.reason ?? fallbackReason ?? null,
    resultMd: data?.resultMd ?? null,
    blockers: blockersFrom(validation),
  };
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

  try {
    return toOutcome(await client.post<RegisterResponse | undefined>('register', body));
  } catch (error) {
    // Alphabot refuses a registration with `success: false` and still returns
    // the validation object. That is an answer, not a failure, so unwrap it
    // rather than letting it surface as an exception.
    if (error instanceof ApiError && error.declined) {
      const data = error.data as RegisterResponse | undefined;
      return { ...toOutcome(data, error.message), success: false };
    }
    throw error;
  }
}
