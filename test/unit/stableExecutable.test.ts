import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveStableExecutable } from '../extension/stableExecutable';

describe('Stable extension-host executable resolution', () => {
  it('uses an accessible launcher path unchanged', async () => {
    const launcher = '/opt/Visual Studio Code/code';
    const accessPath = vi.fn().mockResolvedValue(undefined);

    await expect(resolveStableExecutable(launcher, accessPath, 'linux')).resolves.toBe(launcher);
  });

  it('uses the Darwin Code sibling only for a missing legacy Electron launcher', async () => {
    const legacy = '/tmp/Visual Studio Code.app/Contents/MacOS/Electron';
    const current = path.join(path.dirname(legacy), 'Code');
    const missing = new Error('missing Electron');
    const accessPath = vi.fn(async (candidate: string) => {
      if (candidate === legacy) {
        throw missing;
      }
    });

    await expect(resolveStableExecutable(legacy, accessPath, 'darwin')).resolves.toBe(current);
  });

  it('rethrows the original access error outside Darwin without probing a sibling', async () => {
    const legacy = '/tmp/Visual Studio Code/Code.exe';
    const missing = new Error('missing launcher');
    const accessPath = vi.fn().mockRejectedValue(missing);

    await expect(resolveStableExecutable(legacy, accessPath, 'win32')).rejects.toBe(missing);
    expect(accessPath).toHaveBeenCalledOnce();
  });

  it('rethrows the original access error for an unexpected Darwin basename', async () => {
    const legacy = '/tmp/Visual Studio Code.app/Contents/MacOS/Unexpected';
    const missing = new Error('missing unexpected launcher');
    const accessPath = vi.fn().mockRejectedValue(missing);

    await expect(resolveStableExecutable(legacy, accessPath, 'darwin')).rejects.toBe(missing);
    expect(accessPath).toHaveBeenCalledOnce();
  });
});
