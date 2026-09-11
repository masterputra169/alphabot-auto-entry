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

  it('counts only successful entries', async () => {
    const store = await EntryStore.open(tempDir());
    await store.record({ ...rec('a'), success: true });
    await store.record({ ...rec('b'), success: false });
    expect(store.size).toBe(2);
    expect(store.enteredCount).toBe(1);
  });

  it('blocks an unknown slug never, and a permanent record always', async () => {
    const store = await EntryStore.open(tempDir());
    expect(store.isBlocked('never-seen')).toBe(false);
    await store.record({ ...rec('done'), retryAfter: null });
    expect(store.isBlocked('done')).toBe(true);
  });

  it('keeps a legacy successful record permanent', async () => {
    const store = await EntryStore.open(tempDir());
    await store.record(rec('legacy-ok'));
    expect(store.isBlocked('legacy-ok')).toBe(true);
  });

  it('lets a legacy failed record be attempted again', async () => {
    // Records written before retryAfter existed were Alphabot declines; leaving
    // them permanent would write off everything attempted before the upgrade.
    const store = await EntryStore.open(tempDir());
    await store.record({ ...rec('legacy-fail'), success: false });
    expect(store.isBlocked('legacy-fail')).toBe(false);
  });

  it('unblocks a retryable record once its cooldown passes', async () => {
    const store = await EntryStore.open(tempDir());
    await store.record({ ...rec('later'), success: false, retryAfter: 5000 });
    expect(store.isBlocked('later', 4999)).toBe(true);
    expect(store.isBlocked('later', 5000)).toBe(false);
  });

  it('groups currently-blocked raffles by reason', async () => {
    const store = await EntryStore.open(tempDir());
    const future = Date.now() + 60_000;
    await store.record({ ...rec('a'), success: false, reason: 'tasks', retryAfter: future });
    await store.record({ ...rec('b'), success: false, reason: 'tasks', retryAfter: future });
    await store.record({ ...rec('c'), success: false, reason: 'ended', retryAfter: null });
    await store.record({ ...rec('d'), success: true, retryAfter: null });

    expect(store.blockedByReason()).toEqual({ tasks: 2, ended: 1 });
  });

  it('drops a reason once its cooldown has passed', async () => {
    const store = await EntryStore.open(tempDir());
    await store.record({ ...rec('a'), success: false, reason: 'tasks', retryAfter: 5000 });
    expect(store.blockedByReason(4999)).toEqual({ tasks: 1 });
    expect(store.blockedByReason(5001)).toEqual({});
  });

  it('counts how many blocked raffles each outstanding task holds up', async () => {
    const store = await EntryStore.open(tempDir());
    const soon = Date.now() + 60_000;
    await store.record({ ...rec('a'), success: false, retryAfter: soon, blockers: ['discord'] });
    await store.record({
      ...rec('b'), success: false, retryAfter: soon, blockers: ['discord', 'twitter'],
    });
    await store.record({ ...rec('c'), success: true, retryAfter: null, blockers: [] });

    expect(store.blockedByTask()).toEqual({ discord: 2, twitter: 1 });
  });

  it('ignores blockers on records that are no longer blocked', async () => {
    const store = await EntryStore.open(tempDir());
    await store.record({ ...rec('a'), success: false, retryAfter: 5000, blockers: ['discord'] });
    expect(store.blockedByTask(4999)).toEqual({ discord: 1 });
    expect(store.blockedByTask(5001)).toEqual({});
  });

  it('lists the slugs a given task is holding up', async () => {
    const store = await EntryStore.open(tempDir());
    const soon = Date.now() + 60_000;
    await store.record({ ...rec('a'), success: false, retryAfter: soon, blockers: ['discord'] });
    await store.record({ ...rec('b'), success: false, retryAfter: soon, blockers: ['twitter'] });
    await store.record({ ...rec('c'), success: true, retryAfter: null, blockers: ['discord'] });

    expect(store.blockedSlugs('discord')).toEqual(['a']);
    expect(store.blockedSlugs('twitter')).toEqual(['b']);
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

  it('reports a win as newly recorded the first time only', async () => {
    const store = await EntryStore.open(tempDir());
    await store.record(rec('lucky'));
    expect(await store.markWon('lucky', 'Lucky Raffle')).toBe(true);
    expect(await store.markWon('lucky', 'Lucky Raffle')).toBe(false);
  });

  it('keeps the original entry details when marking a win', async () => {
    const store = await EntryStore.open(tempDir());
    await store.record(rec('lucky'));
    await store.markWon('lucky', 'Lucky Raffle');
    expect(store.get('lucky')?.entries).toBe(2);
    expect(store.get('lucky')?.won).toBe(true);
  });

  it('records a win on a raffle it never attempted itself', async () => {
    const store = await EntryStore.open(tempDir());
    expect(await store.markWon('manual', 'Entered By Hand')).toBe(true);
    expect(store.get('manual')?.name).toBe('Entered By Hand');
    expect(store.isBlocked('manual')).toBe(true);
  });

  it('never reschedules a raffle that was won', async () => {
    const store = await EntryStore.open(tempDir());
    await store.record({ ...rec('lucky'), success: false, retryAfter: 5000 });
    await store.markWon('lucky', 'Lucky Raffle');
    expect(store.isBlocked('lucky', 9_999_999)).toBe(true);
  });

  it('counts wins', async () => {
    const store = await EntryStore.open(tempDir());
    await store.record(rec('a'));
    await store.record(rec('b'));
    await store.markWon('a', 'A');
    expect(store.wonCount).toBe(1);
  });

  it('remembers a win across reopen so it is not alerted twice', async () => {
    const dir = tempDir();
    const first = await EntryStore.open(dir);
    await first.markWon('lucky', 'Lucky Raffle');
    const second = await EntryStore.open(dir);
    expect(await second.markWon('lucky', 'Lucky Raffle')).toBe(false);
    expect(second.wonCount).toBe(1);
  });

  it('keeps a recorded win when a later entry attempt writes its outcome', async () => {
    // The entry queue records a whole fresh record after its register() call,
    // which must not be able to erase a win that landed in the meantime.
    const store = await EntryStore.open(tempDir());
    await store.markWon('lucky', 'Lucky Raffle');
    await store.record({ ...rec('lucky'), success: false, reason: 'tasks', retryAfter: 5000 });
    expect(store.get('lucky')?.won).toBe(true);
    expect(store.wonCount).toBe(1);
    expect(store.isBlocked('lucky', 9_999_999)).toBe(true);
  });

  it('leaves a won raffle out of the blocked stats', async () => {
    const store = await EntryStore.open(tempDir());
    await store.record({
      ...rec('lucky'), success: false, reason: 'tasks', retryAfter: 5000, blockers: ['discord'],
    });
    await store.markWon('lucky', 'Lucky Raffle');
    expect(store.blockedByReason()).toEqual({});
    expect(store.blockedByTask()).toEqual({});
    expect(store.blockedSlugs('discord')).toEqual([]);
  });

  it('does not count a win on a raffle it never entered as an entry', async () => {
    const store = await EntryStore.open(tempDir());
    await store.markWon('manual', 'Entered By Hand');
    expect(store.enteredCount).toBe(0);
    expect(store.wonCount).toBe(1);
  });

  it('marks a win once when two deliveries arrive together', async () => {
    const store = await EntryStore.open(tempDir());
    const results = await Promise.all([
      store.markWon('lucky', 'Lucky Raffle'),
      store.markWon('lucky', 'Lucky Raffle'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('persists both records when two writes overlap', async () => {
    const dir = tempDir();
    const store = await EntryStore.open(dir);
    await Promise.all([store.record(rec('a')), store.markWon('b', 'B')]);
    const raw = JSON.parse(readFileSync(join(dir, 'entered.json'), 'utf8'));
    expect(Object.keys(raw).sort()).toEqual(['a', 'b']);
  });
});
