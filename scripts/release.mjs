// Builds the downloadable release into release/:
//   ClaudeFreeBridge-<version>-windows-x64.zip   ClaudeFreeBridge.exe + extension/ + README.txt + LICENSE
//   claude-free-bridge-extension-<version>.zip   the browser extension on its own (any OS)
//
// Run with `npm run release` on Windows with Node 22+. The .exe is a Node single executable
// application (https://nodejs.org/api/single-executable-applications.html) made from the bundled
// helper; it embeds the Node binary running this script.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const OUT = 'release';
const WORK = join(OUT, 'work');

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

if (process.platform !== 'win32') {
  console.error('The release build makes a Windows .exe, so run it on Windows.');
  process.exit(1);
}
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node 22 or newer is needed to build the .exe (this is ${process.version}).`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

step('Building and testing');
execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' });
execFileSync(process.execPath, ['--test', 'packages/helper/test/helper.test.mjs', 'packages/extension/test/completion.test.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, CLAUDE_FB_QUIET: '1' },
});

// ---------------------------------------------------------------------------------------------
step('Making ClaudeFreeBridge.exe');

const exe = join(WORK, 'ClaudeFreeBridge.exe');
const blob = join(WORK, 'sea-prep.blob');
const seaConfig = join(WORK, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({ main: 'packages/helper/dist/cli.js', output: blob, disableExperimentalSEAWarning: true, useCodeCache: false })
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
copyFileSync(process.execPath, exe);

// Icon and file details (Properties → Details) must be set before the app is injected.
const ico = join(WORK, 'icon.ico');
writeFileSync(ico, makeIco([16, 32, 48, 128].map((s) => readFileSync(`packages/extension/icons/icon${s}.png`))));
const { rcedit } = await import('rcedit');
const fileVersion = `${version.replace(/-.*/, '')}.0`;
await rcedit(exe, {
  icon: ico,
  'file-version': fileVersion,
  'product-version': fileVersion,
  'version-string': {
    FileDescription: 'Claude Free Bridge',
    ProductName: 'Claude Free Bridge',
    OriginalFilename: 'ClaudeFreeBridge.exe',
    InternalFilename: 'ClaudeFreeBridge',
    LegalCopyright: `MIT License`,
  },
});

execFileSync(
  process.execPath,
  [
    'node_modules/postject/dist/cli.js',
    exe,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { stdio: 'inherit' }
);
// The embedded node.exe signature is no longer valid after injection; that's expected for unsigned builds.

// Smoke test: the exe must start and report its version.
const reported = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
if (reported !== version) throw new Error(`ClaudeFreeBridge.exe reports version "${reported}", expected "${version}"`);
console.log(`ClaudeFreeBridge.exe runs and reports ${reported}`);

// ---------------------------------------------------------------------------------------------
step('Packaging');

const appDir = join(WORK, `ClaudeFreeBridge-${version}`);
mkdirSync(appDir, { recursive: true });
copyFileSync(exe, join(appDir, 'ClaudeFreeBridge.exe'));
cpSync('packages/extension/dist', join(appDir, 'extension'), { recursive: true });
copyFileSync('LICENSE', join(appDir, 'LICENSE.txt'));
writeFileSync(
  join(appDir, 'README.txt'),
  `Claude Free Bridge ${version}

Getting started
  1. Double-click ClaudeFreeBridge.exe.
     If Windows says it "protected your PC", click "More info", then "Run anyway".
     (The app isn't code-signed.)
  2. The Control Center window opens. Follow its three setup steps.
     The "extension" folder next to this file is the browser extension it asks you to add.

Keep the ClaudeFreeBridge console window open while you use it. Close it to stop.
To open the Control Center again, double-click ClaudeFreeBridge.exe again.

Settings are saved in %USERPROFILE%\\.claude-free-bridge\\config.json.
More help: ${pkg.homepage}
`.replace(/\n/g, '\r\n')
);

const appZip = join(OUT, `ClaudeFreeBridge-${version}-windows-x64.zip`);
writeZip(appZip, appDir, `ClaudeFreeBridge-${version}`);
const extZip = join(OUT, `claude-free-bridge-extension-${version}.zip`);
writeZip(extZip, 'packages/extension/dist', '');

rmSync(WORK, { recursive: true, force: true });
for (const f of readdirSync(OUT)) console.log(`  ${join(OUT, f)}  (${(statSync(join(OUT, f)).size / 1e6).toFixed(1)} MB)`);
console.log('\nDone.');

// ---------------------------------------------------------------------------------------------
// Helpers

/** An .ico file holding PNG images (supported since Windows Vista). */
function makeIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, i) => {
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const e = 6 + 16 * i;
    header[e] = width >= 256 ? 0 : width;
    header[e + 1] = height >= 256 ? 0 : height;
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listFiles(join(dir, d.name)) : [join(dir, d.name)]
  );
}

/** Minimal zip writer (deflate, no zip64), so the release needs no extra tools. */
function writeZip(zipPath, srcDir, prefix) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of listFiles(srcDir)) {
    const name = Buffer.from([prefix, relative(srcDir, file).split(sep).join('/')].filter(Boolean).join('/'));
    const data = readFileSync(file);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + packed.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(zipPath, Buffer.concat([...locals, ...centrals, end]));
}
