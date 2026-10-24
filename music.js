/** Song lookup via the free iTunes Search API (no key). Returns metadata, cover art and a 30s official preview. */
export async function searchMusic(query, fetchImpl = globalThis.fetch, timeoutMs = 15000) {
  const q = String(query || '').trim().slice(0, 150);
  if (!q) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://itunes.apple.com/search?media=music&entity=song&limit=1&term=${encodeURIComponent(q)}`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const r = data?.results?.[0];
    if (!r?.trackName) return null;
    return {
      title: r.trackName,
      artist: r.artistName || 'Unknown artist',
      album: r.collectionName || '',
      cover: (r.artworkUrl100 || '').replace(/\d+x\d+bb/, '600x600bb') || null,
      preview: r.previewUrl || null,
      link: r.trackViewUrl || null,
    };
  } finally { clearTimeout(t); }
}

/** Full-length tracks that artists share legally (Jamendo, Creative Commons). Needs a free client id. */
export async function searchFullTrack(query, clientId, fetchImpl = globalThis.fetch, timeoutMs = 15000) {
  const q = String(query || '').trim().slice(0, 150);
  if (!q || !clientId) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(clientId)}&format=json&limit=1&audiodownload_allowed=true&search=${encodeURIComponent(q)}`;
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = (await res.json())?.results?.[0];
    if (!r?.name || !r.audiodownload) return null;
    return { title: r.name, artist: r.artist_name || 'Unknown artist', album: r.album_name || '', cover: r.image || null, audio: r.audiodownload, license: r.license_ccurl || '' };
  } finally { clearTimeout(t); }
}
