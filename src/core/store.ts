import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { log } from '../logger.js';

export interface EntryRecord {
  slug: string;
  name: string;
  at: number;
  success: boolean;
  entries: number | null;
  reason: string | null;
  /**
   * When this raffle may be attempted again, or null for never.
   *
   * Alphabot rejecting an entry outright ("one or more tasks incomplete")
   * means nothing was registered *and* the owner can still fix it, so those
   * are worth retrying. A successful entry, or a failure whose outcome is
   * unknown, is permanent — retrying either risks a double entry.
   */
  retryAfter?: number | null;
  /** Task categories Alphabot reported outstanding, e.g. `['discord']`. */
  blockers?: string[];
  /**
   * Alphabot's project for this raffle. Sibling raffles of one project share
   * their Discord requirements, so one lookup can answer for all of them.
   */
  projectId?: string;
  /** Consecutive declines for the same reason; each one lengthens the wait. */
  attempts?: number;
  /** Set once Alphabot reports this raffle as won. Never taken back. */
  won?: boolean;
  /**
   * Whether the win alert actually reached Discord.
   *
   * Winning and announcing are two different facts, and conflating them is
   * what used to lose alerts. Absent on records written before this was
   * tracked, which count as announced so old wins are not replayed.
   */
  announced?: boolean;
}

const FILE_NAME = 'entered.json';

/** Remembers every raffle already attempted, so none is entered twice. */
export class EntryStore {
  /** Distinguishes concurrent writes' temp files from one another. */
  private writeSeq = 0;
  /** Slugs whose alert is being attempted right now, so no two overlap. */
  private readonly announcing = new Set<string>();

  private constructor(
    private readonly filePath: string,
    private readonly records: Map<string, EntryRecord>,
  ) {}

  static async open(dataDir: string): Promise<EntryStore> {
    const filePath = join(dataDir, FILE_NAME);
    const records = new Map<string, EntryRecord>();

    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, EntryRecord>;
      for (const [slug, record] of Object.entries(parsed)) records.set(slug, record);
      log.info(`Loaded ${records.size} previously attempted raffles`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('entered.json was unreadable and will be rebuilt');
      }
    }

    const store = new EntryStore(filePath, records);
    const dropped = await store.prune();
    if (dropped > 0) log.info(`Forgot ${dropped} raffles that were retryable again`);
    return store;
  }

  has(slug: string): boolean {
    return this.records.has(slug);
  }

  get(slug: string): EntryRecord | undefined {
    return this.records.get(slug);
  }

  /** Every raffle attempted, successful or not. */
  get size(): number {
    return this.records.size;
  }

  /** Raffles Alphabot actually accepted. */
  get enteredCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.success) count += 1;
    }
    return count;
  }

  /** Raffles Alphabot reported as won. */
  get wonCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.won) count += 1;
    }
    return count;
  }

  /**
   * Claims the right to announce a win, recording the win itself permanently.
   *
   * True means the caller must announce it. False means someone else already
   * has: the alert has landed before, or an attempt is in flight. The win is
   * recorded either way — a raffle this bot never attempted still gets a
   * record rather than staying eligible for a pointless retry.
   */
  async markWon(slug: string, name: string): Promise<boolean> {
    const existing = this.records.get(slug);
    // `announced` absent means a record from before this was tracked, which
    // counts as told; only an explicit `false` is still outstanding.
    if (existing?.won && existing.announced !== false) return false;
    if (this.announcing.has(slug)) return false;

    this.announcing.add(slug);
    // Already recorded and still outstanding: claim it without rewriting.
    if (existing?.won) return true;

    await this.record(existing
      ? { ...existing, won: true, announced: false, retryAfter: null }
      : {
        slug,
        name,
        at: Date.now(),
        // The bot made no entry of its own here, so this must not count as one.
        success: false,
        entries: null,
        reason: null,
        retryAfter: null,
        won: true,
        announced: false,
      });
    return true;
  }

  /**
   * Releases a claim from `markWon`. A delivered alert is remembered so it is
   * never repeated; an undelivered one stays in `pendingWins` to be retried,
   * rather than depending on Alphabot choosing to redeliver.
   */
  async settleWin(slug: string, delivered: boolean): Promise<void> {
    this.announcing.delete(slug);
    if (!delivered) return;

    const record = this.records.get(slug);
    if (!record) return;
    this.records.set(slug, { ...record, announced: true });
    await this.save();
  }

  /**
   * Forgets records that no longer hold anything back, and reports how many.
   *
   * A raffle whose retry time has passed is already eligible again, so keeping
   * it changes no decision — it only makes the file larger, and every attempt
   * rewrites the whole of it. Deliberately not part of a write: something just
   * recorded must still be readable, whatever its retry time says.
   */
  async prune(now: number = Date.now()): Promise<number> {
    let dropped = 0;
    for (const slug of [...this.records.keys()]) {
      if (this.isBlocked(slug, now)) continue;
      this.records.delete(slug);
      dropped += 1;
    }
    if (dropped > 0) await this.save();
    return dropped;
  }

  /**
   * Records a win that must never be announced.
   *
   * Reconciling against Alphabot turns up wins this bot had no part in —
   * older than the bot, or entered by hand. They are worth remembering so the
   * raffle is not attempted again, but announcing a pile of them at once
   * would be noise rather than news.
   */
  async seedWon(slug: string, name: string): Promise<void> {
    const existing = this.records.get(slug);
    if (existing?.won) return;

    await this.record(existing
      ? { ...existing, won: true, announced: true, retryAfter: null }
      : {
        slug,
        name,
        at: Date.now(),
        success: false,
        entries: null,
        reason: null,
        retryAfter: null,
        won: true,
        announced: true,
      });
  }

  /** Wins whose alert has not reached Discord yet. */
  pendingWins(): EntryRecord[] {
    const pending: EntryRecord[] = [];
    for (const record of this.records.values()) {
      if (record.won && record.announced === false) pending.push(record);
    }
    return pending;
  }

  /** How many currently-blocked raffles sit behind each rejection reason. */
  blockedByReason(now: number = Date.now()): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const record of this.records.values()) {
      if (record.success || record.won || !this.isBlocked(record.slug, now)) continue;
      const key = record.reason ?? 'unknown';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * How many currently-blocked raffles each outstanding task is holding up.
   * This is the answer to "what should I go and do": completing the task at
   * the top of the list unlocks the most raffles.
   */
  blockedByTask(now: number = Date.now()): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const record of this.records.values()) {
      if (record.success || record.won || !this.isBlocked(record.slug, now)) continue;
      for (const task of record.blockers ?? []) {
        counts[task] = (counts[task] ?? 0) + 1;
      }
    }
    return counts;
  }

  /** Slugs currently held back by a particular outstanding task. */
  blockedSlugs(task: string, now: number = Date.now()): string[] {
    const slugs: string[] = [];
    for (const record of this.records.values()) {
      if (record.success || record.won || !this.isBlocked(record.slug, now)) continue;
      if ((record.blockers ?? []).includes(task)) slugs.push(record.slug);
    }
    return slugs;
  }

  /** True while this raffle must not be attempted again. */
  isBlocked(slug: string, now: number = Date.now()): boolean {
    const record = this.records.get(slug);
    if (!record) return false;

    // A won raffle is over. Nothing about it is worth attempting again.
    if (record.won) return true;

    if (record.retryAfter === undefined) {
      // Written before retry tracking existed. A success stays permanent; a
      // failure becomes eligible again, because records from that era were
      // Alphabot declines that the owner can still act on. Without this,
      // everything attempted before the upgrade would be written off forever.
      return record.success;
    }

    if (record.retryAfter === null) return true;
    return now < record.retryAfter;
  }

  async record(entry: EntryRecord): Promise<void> {
    // A win is the final word on a raffle. An entry attempt that resolves after
    // one arrives writes a whole fresh record, and letting that erase the win
    // would let Alphabot's next redelivery announce it a second time.
    const existing = this.records.get(entry.slug);
    this.records.set(entry.slug, existing?.won
      ? { ...entry, won: true, announced: existing.announced, retryAfter: null }
      : entry);
    await this.save();
  }

  /** Losing the file must not lose the in-memory truth the bot is acting on. */
  private async save(): Promise<void> {
    try {
      await this.persist();
    } catch (error) {
      log.warn('Could not persist entered.json; continuing from memory', {
        message: (error as Error).message,
      });
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify(Object.fromEntries(this.records));
    // The entry queue and the win webhook both write here, and they are not
    // serialized against each other. One shared temp path would let a rename
    // publish the other writer's half-written file.
    const tmpPath = `${this.filePath}.${process.pid}.${this.writeSeq++}.tmp`;
    await writeFile(tmpPath, payload, 'utf8');
    await rename(tmpPath, this.filePath);
  }
}
