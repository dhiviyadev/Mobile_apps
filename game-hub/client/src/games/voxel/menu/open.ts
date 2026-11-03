/** Lazy entry for the hub: opens the device's world library and shows the Voxelvale world menu. */
import { getLibrary } from '../library/WorldLibrary';
import { WorldMenu, type WorldMenuHost } from './WorldMenu';

export type { WorldMenuHost } from './WorldMenu';
export type { WorldEntry } from '../library/WorldLibrary';

export async function openWorldMenu(host: WorldMenuHost): Promise<WorldMenu> {
  return new WorldMenu(await getLibrary(), host);
}
