/**
 * Recognises "this game's code couldn't be downloaded" errors: a new deploy
 * replaced the hashed files a long-open tab still points at, or the player is
 * offline before the game was ever downloaded. Messages differ per browser.
 */
const CHUNK_ERROR_RE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading chunk \S+ failed/i;

export const isChunkLoadError = (err: unknown): boolean => err instanceof Error && CHUNK_ERROR_RE.test(err.message);
