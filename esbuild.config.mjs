import esbuild from 'esbuild';

const production = process.argv[2] === 'production';

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  // Obsidian provides these at runtime; bundling them would ship a second copy of the editor.
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: production,
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
