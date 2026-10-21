// Builds everything with esbuild:
//   packages/helper/dist/cli.js, server.js   the helper (Node). The Control Center page is embedded in it.
//   packages/extension/dist/                 the browser extension (load this folder unpacked)
//
//   node build.mjs           one-off build
//   node build.mjs --watch   rebuild on change
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const define = { __VERSION__: JSON.stringify(pkg.version) };

const UI_DIR = 'packages/helper/ui';

/** Provides `virtual:ui-assets`: the Control Center's HTML, CSS and bundled JS as strings. */
const uiAssets = {
  name: 'ui-assets',
  setup(build) {
    build.onResolve({ filter: /^virtual:ui-assets$/ }, () => ({ path: 'ui-assets', namespace: 'ui-assets' }));
    build.onLoad({ filter: /.*/, namespace: 'ui-assets' }, async () => {
      const js = await esbuild.build({
        entryPoints: [`${UI_DIR}/main.ts`],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        minify: !watch,
        metafile: true,
        define,
      });
      const html = readFileSync(`${UI_DIR}/index.html`, 'utf8');
      const css = readFileSync(`${UI_DIR}/ui.css`, 'utf8');
      return {
        contents: `export const html = ${JSON.stringify(html)};\nexport const css = ${JSON.stringify(css)};\nexport const js = ${JSON.stringify(js.outputFiles[0].text)};\n`,
        loader: 'js',
        watchFiles: [`${UI_DIR}/index.html`, `${UI_DIR}/ui.css`, ...Object.keys(js.metafile.inputs)],
      };
    });
  },
};

const helper = {
  entryPoints: {
    cli: 'packages/helper/src/cli.ts',
    server: 'packages/helper/src/server.ts',
  },
  outdir: 'packages/helper/dist',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // Everything is bundled (no runtime dependencies), so the same file also becomes the .exe.
  // ws optionally loads these native add-ons and works without them.
  external: ['bufferutil', 'utf-8-validate'],
  define,
  plugins: [uiAssets],
  logLevel: 'info',
};

const extensionOut = 'packages/extension/dist';
const extension = {
  entryPoints: {
    background: 'packages/extension/src/background.ts',
    content: 'packages/extension/src/content.ts',
    sidepanel: 'packages/extension/src/sidepanel/panel.ts',
  },
  outdir: extensionOut,
  bundle: true,
  platform: 'browser',
  target: 'chrome116',
  format: 'iife',
  define,
  logLevel: 'info',
};

function copyExtensionStatic() {
  mkdirSync(extensionOut, { recursive: true });
  const manifest = JSON.parse(readFileSync('packages/extension/manifest.json', 'utf8'));
  manifest.version = pkg.version;
  writeFileSync(`${extensionOut}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  cpSync('packages/extension/src/sidepanel/sidepanel.html', `${extensionOut}/sidepanel.html`);
  cpSync('packages/extension/src/sidepanel/sidepanel.css', `${extensionOut}/sidepanel.css`);
  cpSync('packages/extension/icons', `${extensionOut}/icons`, { recursive: true });
}

rmSync('packages/helper/dist', { recursive: true, force: true });
rmSync(extensionOut, { recursive: true, force: true });
copyExtensionStatic();

if (watch) {
  const contexts = await Promise.all([helper, extension].map((o) => esbuild.context(o)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('Watching for changes (extension HTML/CSS/manifest are copied on start only)...');
} else {
  await Promise.all([helper, extension].map((o) => esbuild.build(o)));
}
