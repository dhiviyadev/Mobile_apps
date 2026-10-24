/**
 * A random per-browser secret that lets saved survival worlds recognise a
 * returning player (JoinOptions.playerKey). The server keeps only a hash.
 * Without storage it lasts one page load (survival still works, unsaved).
 */
const KEY = 'cobalt-hub.player-key.v1';
let cached: string | null = null;

function randomKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); // 22 chars
}

export function getPlayerKey(): string {
  if (cached) return cached;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && /^[A-Za-z0-9_-]{16,32}$/.test(stored)) return (cached = stored);
  } catch {
    /* storage blocked */
  }
  cached = randomKey();
  try {
    localStorage.setItem(KEY, cached);
  } catch {
    /* keep it for this page load only */
  }
  return cached;
}
