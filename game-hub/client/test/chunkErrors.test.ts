import { describe, expect, it } from 'vitest';
import { isChunkLoadError } from '../src/platform/chunkErrors';

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/assets/index-abc.js', // Chrome
    'error loading dynamically imported module: https://x/assets/index-abc.js', // Firefox
    'Importing a module script failed.', // Safari
    'Unable to preload CSS for /assets/index-abc.css', // Vite
  ])('recognises "%s"', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isChunkLoadError(new Error('Could not join the room.'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
