export const extensionBuildOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'out/src/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: false,
};
