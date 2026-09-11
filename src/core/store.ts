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
  /** Set once Alphabot reports this raffle as won. */
  won?: boolean;
}

const FILE_NAME = 'entered.json';

/** Remembers every raffle already attempted, so none is entered twice. */
export class EntryStore {
  /** Distinguishes concurrent writes' temp files from one another. */
  private writeSeq = 0;

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

    return new EntryStore(filePath, records);
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
   * Marks a raffle as won and reports whether that was news.
   *
   * Alphabot retries webhook deliveries, so the same `raffle:won` can arrive
   * more than once; returning false on a repeat is what keeps the win channel
   * from pinging twice. A win also implies an entry exists, so a raffle this
   * bot never attempted still gets a permanent record rather than staying
   * eligible for a pointless retry.
   */
  async markWon(slug: string, name: string): Promise<boolean> {
    const existing = this.records.get(slug);
    if (existing?.won) return false;

    await this.record(existing
      ? { ...existing, won: true, retryAfter: null }
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
      });
    return true;
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
      ? { ...entry, won: true, retryAfter: null }
      : entry);
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
    const payload = JSON.stringify(Object.fromEntries(this.records), null, 2);
    // The entry queue and the win webhook both write here, and they are not
    // serialized against each other. One shared temp path would let a rename
    // publish the other writer's half-written file.
    const tmpPath = `${this.filePath}.${process.pid}.${this.writeSeq++}.tmp`;
    await writeFile(tmpPath, payload, 'utf8');
    await rename(tmpPath, this.filePath);
  }
}
