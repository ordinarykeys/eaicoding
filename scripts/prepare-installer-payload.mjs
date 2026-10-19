// Build the same separate 7-Zip payload used by Harness's NSIS extraction flow.
import { cp, copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'src-tauri/target/installer-ui');
const staging = join(output, 'payload');
const archive = join(output, 'payload.7z');
const require = createRequire(import.meta.url);
const tool = join(dirname(require.resolve('7zip-bin/package.json')), 'win/x64/7za.exe');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 installer build required');
const executable = resolve(process.argv[2] || '');
if (!process.argv[2] || !(await stat(executable)).isFile()) throw new Error('Pass the exact Tauri bundle executable');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
// Only this generated directory is replaced; no installed files are touched here.
if (dirname(staging) !== output) throw new Error('Invalid payload staging directory');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await copyFile(executable, join(staging, basename(executable)));
await cp(join(root, 'src-tauri/resources/eagent-tools'), join(staging, 'eagent-tools'), { recursive: true });
await cp(join(root, 'src-tauri/target/model-runtime'), join(staging, 'model-runtime'), { recursive: true });
await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(staging, 'THIRD_PARTY_NOTICES.md'));
await cp(join(root, 'third_party/7zip'), join(staging, 'licenses/7zip'), { recursive: true });
await rm(archive, { force: true });
// Non-solid LZMA2 bounds decode work and reports real progress even inside large files.
const result = spawnSync(tool, ['a', '-t7z', '-m0=LZMA2', '-mx=3', '-ms=off', '-mmt=2', '-bsp0', archive, '.\\*'], {
  cwd: staging, stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Installer payload compression failed: ${result.status}`);
if (!(await readdir(staging)).includes(basename(executable))) throw new Error('Incomplete payload');
console.log(`Prepared EAiCoding ${version} installer payload (${(await stat(archive)).size} bytes)`);
