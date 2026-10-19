import { build } from 'esbuild';
import { copyFile, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { catalog } from '../runtime/model-runtime.mjs';
const destination = 'src-tauri/target/model-runtime';
await mkdir(destination, { recursive: true });
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 打包需要同架构的 Node.js。');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('模型认证运行时需要 Node.js 22.19 或更新版本。');
const result = await build({ entryPoints: ['runtime/host.mjs'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: destination + '/host.cjs', metafile: true, logLevel: 'warning' });
await copyFile(process.execPath, destination + '/node.exe');
const nodeLicense = await readFile(join(dirname(process.execPath), 'LICENSE'), 'utf8');
await writeFile(destination + '/NODE-LICENSE.txt', nodeLicense);
// Derive notices from the files actually bundled, including Node-only AWS/ADC.
const roots = [...new Set(Object.keys(result.metafile.inputs).map(p => p.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/)?.[1]).filter(Boolean))].sort();
const notices = ['Third-party components bundled in EAiCoding model-runtime/host.cjs.\nNode.js and its dependencies: see NODE-LICENSE.txt.\n'];
for (const root of roots) {
  const pkg = JSON.parse(await readFile(root + '/package.json', 'utf8'));
  const files = (await readdir(root)).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  let texts = await Promise.all(files.map(name => readFile(root + '/' + name, 'utf8')));
  if (!texts.length) {
    if (pkg.name === '@earendil-works/pi-ai') texts = [await readFile('third_party/model-runtime/pi-ai-LICENSE', 'utf8')];
    else if (pkg.name === 'standardwebhooks') texts = [await readFile('third_party/model-runtime/standardwebhooks-LICENSE', 'utf8')];
    else if (pkg.name === 'proxy-agent-negotiate') texts = [await readFile('third_party/model-runtime/proxy-agents-LICENSE', 'utf8')];
    else if (pkg.name === 'data-uri-to-buffer') texts = [(await readFile(root + '/README.md', 'utf8')).split('License\n-------')[1] ?? (await readFile(root + '/README.md', 'utf8')).split('License\r\n-------')[1]];
    else if (pkg.name.startsWith('@aws-sdk/')) texts = [await readFile('node_modules/@aws-sdk/client-bedrock-runtime/LICENSE', 'utf8')];
    else throw new Error('Missing bundled dependency notice: ' + pkg.name);
  }
  if (texts.some(text => !text?.trim())) throw new Error('Empty dependency license: ' + pkg.name);
  notices.push('\n' + pkg.name + '@' + pkg.version + '\nLicense: ' + pkg.license + '\n' + texts.join('\n'));
}
await writeFile(destination + '/THIRD-PARTY-LICENSES.txt', notices.join('\n'));
await writeFile('src/lib/provider-auth-catalog.json', JSON.stringify(catalog));
await writeFile(destination + '/manifest.json', JSON.stringify({ node: process.versions.node, piAI: '1.1.0', sha256: createHash('sha256').update(await readFile(destination + '/host.cjs')).digest('hex') }, null, 2));
await mkdir('.tmp', { recursive: true });
await writeFile('.tmp/model-runtime-metafile.json', JSON.stringify(result.metafile));
console.log('Prepared bundled model runtime: Node ' + process.versions.node + ', ' + catalog.length + ' providers.');
