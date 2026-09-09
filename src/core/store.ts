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
}

const FILE_NAME = 'entered.json';

/** Remembers every raffle already attempted, so none is entered twice. */
export class EntryStore {
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

  get size(): number {
    return this.records.size;
  }

  async record(entry: EntryRecord): Promise<void> {
    this.records.set(entry.slug, entry);
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
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, payload, 'utf8');
    await rename(tmpPath, this.filePath);
  }
}
