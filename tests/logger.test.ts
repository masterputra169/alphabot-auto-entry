import { describe, expect, it, vi, afterEach } from 'vitest';
import { log, redact, registerSecret } from '../src/logger.js';

afterEach(() => vi.restoreAllMocks());

describe('redact', () => {
  it('masks registered secrets anywhere in the text', () => {
    registerSecret('super-secret-key');
    expect(redact('token=super-secret-key done')).toBe('token=[REDACTED] done');
  });

  it('ignores empty or null secrets', () => {
    registerSecret(null);
    registerSecret('');
    expect(redact('nothing to hide')).toBe('nothing to hide');
  });

  it('ignores values too short to be secrets', () => {
    registerSecret('abc');
    expect(redact('abc')).toBe('abc');
  });
});

describe('log', () => {
  it('writes a level, a timestamp and the message', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.info('hello');
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/INFO.*hello/);
  });

  it('sends warnings to console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log.warn('careful');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('redacts secrets in the message and the metadata', () => {
    registerSecret('abc123xyz');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.error('key abc123xyz failed', { key: 'abc123xyz' });
    const line = spy.mock.calls[0]?.join(' ') ?? '';
    expect(line).not.toContain('abc123xyz');
    expect(line).toContain('[REDACTED]');
  });

  it('omits the metadata argument when none is given', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.debug('plain');
    expect(spy.mock.calls[0]).toHaveLength(1);
  });
});
