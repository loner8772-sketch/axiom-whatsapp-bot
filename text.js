export function formatUptime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s % 60}s`].filter(Boolean).join(' ');
}

export function splitMessage(text, max = 3500) {
  const t = String(text ?? '');
  if (t.length <= max) return [t];
  const out = [];
  let rest = t;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export function parseCommand(text, prefix = '.') {
  if (!text || !text.startsWith(prefix)) return null;
  const body = text.slice(prefix.length).trim();
  const m = body.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!/^[a-z0-9]+$/.test(name)) return null;
  const rest = (m[2] ?? '').trim();
  return { name, rest, args: rest ? rest.split(/\s+/) : [] };
}
