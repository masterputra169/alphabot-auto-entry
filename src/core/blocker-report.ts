import { AuthError, BudgetExhaustedError, type AlphabotClient } from '../api/client.js';
import { getRaffleWithRequirements } from '../api/raffles.js';
import type { AppConfig } from '../config.js';
import { log } from '../logger.js';
import type { EntryStore } from './store.js';

/**
 * GETs held back so the poller's list call always fits.
 *
 * That call costs exactly one per cycle — the poller guards its own optional
 * requirement lookups separately — so reserving more than a call plus a spare
 * only left budget unspent while hundreds of raffles waited to be looked up.
 */
const BUDGET_RESERVE = 2;

export interface BlockingServer {
  id: string;
  label: string;
  raffles: number;
  /** Invite Alphabot published for the server, when it gave one. */
  invite: string | null;
  /**
   * Roles the raffles recognise inside that server, cheapest first.
   *
   * Empty means plain membership is enough. Otherwise these are alternatives,
   * not a checklist: each carries an entry multiplier, so the lowest `val` is
   * normally the basic role a server hands out on verification, and the
   * higher ones are tiers that simply award more entries.
   */
  roles: BlockingRole[];
}

export interface BlockingRole {
  name: string;
  /** Entry multiplier Alphabot attaches to the role, when it gives one. */
  val: number | null;
}

interface ServerRequirement {
  id: string;
  label: string;
  invite: string | null;
  roles: BlockingRole[];
}

/** Cheapest first; a role with no multiplier sorts last. */
function byCost(a: BlockingRole, b: BlockingRole): number {
  return (a.val ?? Number.MAX_SAFE_INTEGER) - (b.val ?? Number.MAX_SAFE_INTEGER);
}

export interface BlockerReportDeps {
  config: AppConfig;
  client: AlphabotClient;
  store: Pick<EntryStore, 'blockedSlugs' | 'get'>;
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
  /**
   * projectId -> the servers one of its raffles turned out to require.
   *
   * Alphabot runs whole families of raffles off a single project and they
   * share the Discord requirement, so answering for the family from one
   * lookup is the difference between the report keeping up and not.
   */
  private readonly byProject = new Map<string, ServerRequirement[]>();
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
          if (!seen.roles.some((r) => r.name === role.name)) seen.roles.push(role);
        }
        seen.roles.sort(byCost);
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

    let shared = 0;
    let spent = false;

    for (const slug of blocked) {
      if (this.examined.has(slug)) continue;

      // Free: a sibling of the same project already established this, whether
      // on an earlier cycle or moments ago in this very loop. Checked before
      // the budget, so an exhausted budget cannot stop it.
      const known = this.projectServers(slug);
      if (known) {
        this.servers.set(slug, known);
        this.examined.add(slug);
        shared += 1;
        continue;
      }

      // Out of budget or out of turns: skip rather than break, because a
      // later raffle may still be answerable from the cache for nothing.
      if (spent) continue;
      if (resolved >= config.poll.maxResolvesPerCycle) continue;
      if (client.budgetRemaining <= BUDGET_RESERVE) continue;

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
              .filter((r): r is { name: string; val?: number } => Boolean(r.name))
              .map((r) => ({ name: r.name, val: r.val ?? null }))
              .sort(byCost),
          }));

        if (servers.length > 0) {
          this.servers.set(slug, servers);
          // The fetched raffle is the authority on its own project; the store
          // record may predate projects being tracked at all.
          const projectId = raffle?.projectId ?? this.projectOf(slug);
          if (projectId) this.byProject.set(projectId, servers);
        }
      } catch (error) {
        if (error instanceof BudgetExhaustedError) {
          spent = true;
          continue;
        }
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

    if (resolved > 0 || shared > 0) {
      const top = this.ranked[0];
      log.info(`Blocker report looked up ${resolved} raffles`, {
        fromProjectCache: shared,
        stillPending: this.pending,
        topServer: top
          ? `${top.label} unlocks ${top.raffles}`
            + (top.roles.length > 0
            ? ` (cheapest role: ${top.roles[0]?.name})`
            : ' (membership only)')
          : null,
      });
    }
  }

  /** The project this raffle belongs to, when the store knows of one. */
  private projectOf(slug: string): string | undefined {
    return this.deps.store.get(slug)?.projectId;
  }

  /** Requirements a sibling raffle of the same project already established. */
  private projectServers(slug: string): ServerRequirement[] | undefined {
    const projectId = this.projectOf(slug);
    return projectId ? this.byProject.get(projectId) : undefined;
  }

  /** Forget raffles that are no longer blocked, so the maps cannot grow forever. */
  private prune(blocked: ReadonlySet<string>): void {
    for (const slug of this.servers.keys()) {
      if (!blocked.has(slug)) this.servers.delete(slug);
    }
    for (const slug of this.examined) {
      if (!blocked.has(slug)) this.examined.delete(slug);
    }

    const live = new Set<string>();
    for (const slug of blocked) {
      const projectId = this.projectOf(slug);
      if (projectId) live.add(projectId);
    }
    for (const projectId of this.byProject.keys()) {
      if (!live.has(projectId)) this.byProject.delete(projectId);
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
