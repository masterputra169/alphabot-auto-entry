import { AuthError, BudgetExhaustedError, type AlphabotClient } from '../api/client.js';
import { getRaffleWithRequirements } from '../api/raffles.js';
import type { AppConfig } from '../config.js';
import { log } from '../logger.js';
import type { EntryStore } from './store.js';

/** GETs held back so the poller's list call always fits. */
const BUDGET_RESERVE = 4;

export interface BlockingServer {
  id: string;
  label: string;
  raffles: number;
  /** Invite Alphabot published for the server, when it gave one. */
  invite: string | null;
  /**
   * Roles the raffles ask for inside that server. Empty means plain
   * membership is enough; a named role usually means going through the
   * server's verification first, which is a different amount of work.
   */
  roles: string[];
}

interface ServerRequirement {
  id: string;
  label: string;
  invite: string | null;
  roles: string[];
}

export interface BlockerReportDeps {
  config: AppConfig;
  client: AlphabotClient;
  store: Pick<EntryStore, 'blockedSlugs'>;
}

/**
 * Turns "15 raffles are blocked on Discord" into "join ZeroLabs and five of
 * them open up".
 *
 * Alphabot's validation names the failing category but not the server, so
 * each blocked raffle needs one `GET /raffles/{slug}?requirements=true` to
 * learn which Discord it wants. That is looked up once per raffle and cached,
 * inside the same hourly budget the poller respects.
 */
export class BlockerReport {
  /** slug -> the servers that raffle requires. */
  private readonly servers = new Map<string, ServerRequirement[]>();
  /** Slugs already looked up, so budget is never spent twice on one raffle. */
  private readonly examined = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: BlockerReportDeps) {}

  /** Servers ranked by how many currently-blocked raffles each one holds up. */
  get ranked(): BlockingServer[] {
    const counts = new Map<string, BlockingServer>();

    for (const slug of this.deps.store.blockedSlugs('discord')) {
      for (const server of this.servers.get(slug) ?? []) {
        const seen = counts.get(server.id);
        if (!seen) {
          counts.set(server.id, { ...server, raffles: 1, roles: [...server.roles] });
          continue;
        }
        seen.raffles += 1;
        seen.invite ??= server.invite;
        for (const role of server.roles) {
          if (!seen.roles.includes(role)) seen.roles.push(role);
        }
      }
    }

    return [...counts.values()].sort((a, b) => b.raffles - a.raffles);
  }

  /** How many blocked raffles have not been looked up yet. */
  get pending(): number {
    return this.deps.store.blockedSlugs('discord')
      .filter((slug) => !this.examined.has(slug)).length;
  }

  async refresh(): Promise<void> {
    const { client, config, store } = this.deps;
    const blocked = store.blockedSlugs('discord');
    let resolved = 0;

    for (const slug of blocked) {
      if (this.examined.has(slug)) continue;
      if (resolved >= config.poll.maxResolvesPerCycle) break;
      if (client.budgetRemaining <= BUDGET_RESERVE) break;

      try {
        const raffle = await getRaffleWithRequirements(client, slug);
        this.examined.add(slug);
        resolved += 1;

        const servers: ServerRequirement[] = (raffle?.discordServerRoles ?? [])
          .filter((s) => s.exclude !== true)
          .map((s) => ({
            id: s.id,
            label: s.label ?? s.id,
            invite: s.inviteLink ?? null,
            roles: (s.roles ?? [])
              .map((r) => r.name)
              .filter((name): name is string => Boolean(name)),
          }));

        if (servers.length > 0) this.servers.set(slug, servers);
      } catch (error) {
        if (error instanceof BudgetExhaustedError) break;
        if (error instanceof AuthError) {
          log.error('Blocker report halted: Alphabot rejected the API key');
          break;
        }
        // Do not let one broken raffle consume budget on every cycle.
        this.examined.add(slug);
        log.warn(`Could not look up blockers for ${slug}`, {
          message: (error as Error).message,
        });
      }
    }

    this.prune(new Set(blocked));

    if (resolved > 0) {
      const top = this.ranked[0];
      log.info(`Blocker report looked up ${resolved} raffles`, {
        stillPending: this.pending,
        topServer: top
          ? `${top.label} unlocks ${top.raffles}`
            + (top.roles.length > 0 ? ` (needs role: ${top.roles.join(', ')})` : ' (membership only)')
          : null,
      });
    }
  }

  /** Forget raffles that are no longer blocked, so the map cannot grow forever. */
  private prune(blocked: ReadonlySet<string>): void {
    for (const slug of this.servers.keys()) {
      if (!blocked.has(slug)) this.servers.delete(slug);
    }
    for (const slug of this.examined) {
      if (!blocked.has(slug)) this.examined.delete(slug);
    }
  }

  start(): void {
    if (!this.deps.config.poll.enabled || this.timer) return;
    const intervalMs = this.deps.config.poll.intervalSeconds * 1000;
    this.timer = setInterval(() => {
      void this.refresh().catch((error: Error) => {
        log.warn('Blocker report cycle failed', { message: error.message });
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
