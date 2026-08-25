import path from 'node:path';

import { restoreCodexDropPatch } from './lib/codex-drop-installation.mjs';

function optionsFromArguments(arguments_) {
  if (arguments_.length === 0) return {};
  if (arguments_.length === 2 && arguments_[0] === '--extension-dir') {
    return { extensionDir: path.resolve(arguments_[1]) };
  }
  throw new Error('Usage: unpatch-codex-drop [--extension-dir <path>]');
}

try {
  const result = await restoreCodexDropPatch(optionsFromArguments(process.argv.slice(2)));
  if (result.status === 'restored') {
    console.log(`Restored Codex ${result.extensionVersion}`);
  } else {
    console.log(`Codex ${result.extensionVersion} is already restored`);
  }
  console.log(`Bundle: ${result.bundlePath}`);
  if (result.indexPath !== undefined) console.log(`Index: ${result.indexPath}`);
  console.log(`Status: ${result.status}`);
  if (result.status === 'restored') console.log('Reload VS Code to use the updated Codex webview.');
} catch (error) {
  console.error(`Codex drop restore failed: ${error.message}`);
  process.exitCode = 1;
}
