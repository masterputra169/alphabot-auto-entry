const secrets = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
  return out;
}

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

function emit(level: Level, message: string, meta?: unknown): void {
  const line = `${new Date().toISOString()} ${level} ${redact(message)}`;
  const extra = meta === undefined ? undefined : redact(JSON.stringify(meta));
  const sink = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
}

export const log = {
  debug: (m: string, meta?: unknown) => emit('DEBUG', m, meta),
  info: (m: string, meta?: unknown) => emit('INFO', m, meta),
  warn: (m: string, meta?: unknown) => emit('WARN', m, meta),
  error: (m: string, meta?: unknown) => emit('ERROR', m, meta),
};
