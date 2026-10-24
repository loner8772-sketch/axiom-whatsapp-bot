const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_RE = [
  /mongodb(\+srv)?:\/\/[^\s"']+/gi,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /(token|key|password|secret)=([^\s&"']+)/gi,
];

export function redact(value) {
  let s = typeof value === 'string' ? value : value instanceof Error ? `${value.name}: ${value.message}` : JSON.stringify(value);
  for (const re of SECRET_RE) s = s.replace(re, (m, a, b) => (b ? `${a}=***` : '[redacted]'));
  return s;
}

export function createLogger(level = 'info', sink = console) {
  const min = LEVELS[level] ?? 20;
  const make = (name) => (...parts) => {
    if (LEVELS[name] < min) return;
    const line = `${new Date().toISOString()} ${name.toUpperCase()} ${parts.map(redact).join(' ')}`;
    (name === 'error' ? sink.error : name === 'warn' ? sink.warn : sink.log)(line);
  };
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
}
