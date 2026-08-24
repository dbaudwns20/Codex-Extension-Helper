import { access } from 'node:fs/promises';
import * as path from 'node:path';

export async function resolveStableExecutable(
  legacyPath: string,
  accessPath: (candidate: string) => Promise<void> = access,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  try {
    await accessPath(legacyPath);
    return legacyPath;
  } catch (error) {
    if (platform !== 'darwin' || path.basename(legacyPath) !== 'Electron') {
      throw error;
    }
    const currentPath = path.join(path.dirname(legacyPath), 'Code');
    await accessPath(currentPath);
    return currentPath;
  }
}
