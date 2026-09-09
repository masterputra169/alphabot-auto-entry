export type ReqLetter = 'n' | 'd' | 'r' | 'f' | 'l' | 't' | 'g';

export interface RaffleForList {
  _id: string;
  slug: string;
  name: string;
  type?: string;
  status: string;
  visibility?: string;
  description?: string;
  startDate?: number;
  endDate?: number;
  winnerCount?: number;
  bannerImageUrl?: string;
  blockchain?: string;
  twitterUrl?: string;
  discordUrl?: string;
  entryCount?: number;
  reqString?: string;
  projectId?: string;
  teamId?: string;
  dtc?: boolean;
}

export interface DiscordRoleRequirement {
  roleId?: string;
  val?: number;
  name?: string;
  stacking?: boolean;
}

export interface DiscordServerRole {
  id: string;
  label?: string;
  inviteLink?: string;
  exclude?: boolean;
  roles?: DiscordRoleRequirement[];
}

export interface RaffleRequirements {
  requirePremium?: boolean;
  connectDiscord?: boolean;
  connectTwitter?: boolean;
  connectWallet?: boolean;
  connectEmail?: boolean;
  connectTelegram?: boolean;
  connectPassword?: boolean;
  connectCaptcha?: boolean;
  signWallet?: boolean;
  excludePreviousWinners?: boolean;
  requiredEth?: number;
  requiredTokens?: unknown[];
  discordServerRoles?: DiscordServerRole[];
  twitterFollows?: { id?: string; name?: string; image?: string }[];
  twitterRetweet?: string;
  twitterRetweetType?: string;
}

export type RaffleWithRequirements = RaffleForList & RaffleRequirements;

export interface ValidationResult {
  entries?: number;
  success?: boolean;
  reason?: string;
  discordValid?: boolean;
  twitterValid?: boolean;
  tokensValid?: boolean;
  emailValid?: boolean;
  ethBalanceValid?: boolean;
  questionsValid?: boolean;
  passwordInvalid?: boolean;
}

export interface RegisterResponse {
  resultMd?: string;
  validation?: ValidationResult;
  pendingCheck?: { start?: number; complete?: number };
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  errors?: { message?: string; code?: string }[];
}

export interface RafflesListData {
  raffles: RaffleForList[];
  finalPage?: boolean;
}

export interface RaffleEntry {
  slug?: string;
  mintAddress?: string;
  discordName?: string;
  twitterName?: string;
  entries?: number;
  winner?: boolean;
}

export interface WebhookBody {
  event: string;
  timestamp: number;
  hash: string;
  data?: {
    raffle?: RaffleWithRequirements;
    entry?: RaffleEntry;
    user?: { _id?: string; address?: string };
  };
}
