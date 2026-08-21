import { build } from 'esbuild';
import { extensionBuildOptions } from './esbuild-options.mjs';

await build(extensionBuildOptions);
