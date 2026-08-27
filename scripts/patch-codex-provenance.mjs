import path from 'node:path';

import { applyCodexProvenancePatch } from './lib/codex-provenance-installation.mjs';

function optionsFromArguments(arguments_) {
  if (arguments_.length === 0) return {};
  if (arguments_.length === 2 && arguments_[0] === '--extension-dir') {
    return { extensionDir: path.resolve(arguments_[1]) };
  }
  throw new Error('Usage: patch-codex-provenance [--extension-dir <path>]');
}

try {
  const result = await applyCodexProvenancePatch(optionsFromArguments(process.argv.slice(2)));
  if (result.status === 'patched') console.log(`Patched Codex ${result.extensionVersion}`);
  else console.log(`Codex ${result.extensionVersion} is already patched`);
  console.log(`Installation: ${result.extensionDir}`);
  console.log(`Target: ${result.targetPath}`);
  console.log(`Status: ${result.status}`);
  if (result.status === 'patched') {
    console.log('Reload VS Code to activate exact Codex change provenance.');
  }
} catch (error) {
  console.error(`Codex provenance patch failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
