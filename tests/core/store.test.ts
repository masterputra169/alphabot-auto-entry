import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EntryStore } from '../../src/core/store.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'abstore-'));

const rec = (slug: string) => ({
  slug, name: `Raffle ${slug}`, at: 1000, success: true, entries: 2, reason: null,
});

describe('EntryStore', () => {
  it('starts empty when the file does not exist', async () => {
    const store = await EntryStore.open(join(tempDir(), 'nested'));
    expect(store.size).toBe(0);
    expect(store.has('anything')).toBe(false);
    expect(store.get('anything')).toBeUndefined();
  });

  it('records and reads back an entry', async () => {
    const store = await EntryStore.open(tempDir());
    await store.record(rec('cool-raffle'));
    expect(store.has('cool-raffle')).toBe(true);
    expect(store.get('cool-raffle')?.entries).toBe(2);
    expect(store.size).toBe(1);
  });

  it('persists across reopen', async () => {
    const dir = tempDir();
    const first = await EntryStore.open(dir);
    await first.record(rec('persisted'));
    const second = await EntryStore.open(dir);
    expect(second.has('persisted')).toBe(true);
  });

  it('creates the data directory when it does not exist yet', async () => {
    const dir = join(tempDir(), 'deep', 'nested');
    const store = await EntryStore.open(dir);
    await store.record(rec('x'));
    expect(JSON.parse(readFileSync(join(dir, 'entered.json'), 'utf8')).x.slug).toBe('x');
  });

  it('writes valid json to entered.json', async () => {
    const dir = tempDir();
    const store = await EntryStore.open(dir);
    await store.record(rec('x'));
    const raw = JSON.parse(readFileSync(join(dir, 'entered.json'), 'utf8'));
    expect(raw.x.slug).toBe('x');
  });

  it('overwrites an existing record for the same slug', async () => {
    const store = await EntryStore.open(tempDir());
    await store.record(rec('dupe'));
    await store.record({ ...rec('dupe'), success: false, reason: 'later' });
    expect(store.size).toBe(1);
    expect(store.get('dupe')?.reason).toBe('later');
  });

  it('recovers from a corrupted file instead of crashing', async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'entered.json'), '{not json');
    const store = await EntryStore.open(dir);
    expect(store.size).toBe(0);
    await store.record(rec('after-corruption'));
    expect(store.has('after-corruption')).toBe(true);
  });

  it('keeps the in-memory record when the disk write fails', async () => {
    const store = await EntryStore.open(tempDir());
    const spy = vi
      .spyOn(store as unknown as { persist: () => Promise<void> }, 'persist')
      .mockRejectedValue(new Error('disk full'));
    await expect(store.record(rec('resilient'))).resolves.toBeUndefined();
    expect(store.has('resilient')).toBe(true);
    spy.mockRestore();
  });
});
