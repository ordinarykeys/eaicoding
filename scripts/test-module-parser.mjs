import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const temp = await mkdtemp(path.join(tmpdir(), 'eaicoding-module-parser-'));
try {
  const file = path.join(temp, 'parser.mjs');
  await build({ entryPoints: ['src/services/knowledge/module-parser.ts'], outfile: file, bundle: true, platform: 'node', format: 'esm' });
  const { parseRawModuleApis } = await import(pathToFileURL(file).href);
  const source = [
    '.程序集 线程池, , 公开, 线程池说明',
    '.程序集变量 状态, 整数型',
    '.子程序 启动, 整数型, 公开, "含逗号,说明"',
    '.参数 任务, 整数型, 参考 可空, "指针,可空"',
    '.局部变量 内部, 整数型',
    '.子程序 内部方法, , , 只在模块内部使用',
    '.数据类型 任务信息, 公开',
    '.成员 指针, 整数型',
    '.常量 默认线程数, 4, 公开',
    '.全局变量 全局状态, 整数型',
    '.DLL命令 Sleep, , "kernel32.dll", "Sleep", , "等待,毫秒"',
    '.参数 时间, 整数型',
  ].join('\r\n');
  const progress = [];
  const parsed = parseRawModuleApis(source, (done, total) => progress.push([done, total]));
  assert.equal(parsed.apis.length, 3);
  assert.equal(parsed.apis.filter(api => api.isPublic).length, 1);
  assert.equal(parsed.apis[0].params.length, 1);
  assert.equal(parsed.apis[0].params[0].description, '"指针,可空"');
  assert.equal(parsed.apis[0].params[0].byRef, true);
  assert.equal(parsed.apis[0].params[0].optional, true);
  assert.equal(parsed.apis[2].params[0].name, '时间');
  assert.equal(parsed.assemblies[0].publicMethodCount, 1);
  assert.deepEqual(parsed.declarations.map(d => d.kind), ['程序集变量', '数据类型', '成员', '常量', '全局变量']);
  assert.equal(progress.at(-1)[0], progress.at(-1)[1]);
  const large = parseRawModuleApis(Array.from({ length: 5000 }, (_, i) => `.子程序 命令${i}, 整数型, 公开\n.参数 数值, 整数型`).join('\n'));
  assert.equal(large.apis.length, 5000); assert.equal(large.apis.at(-1).name, '命令4999');
  console.log('PASS module declarations, quoted commas, visibility, parameter attributes and complete large-module parsing');
} finally { await rm(temp, { recursive: true, force: true }); }
