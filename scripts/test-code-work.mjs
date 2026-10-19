import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/lib/turn-changes.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { turnChanges, comparisonRows, unifiedRows } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const result = (sourceChange, ok = true) => ({ ok, sourceChange });
const trace = { steps: [
  { toolResults: [result({ path: 'D:\\work\\窗口.epl', before: '首行\r\n旧一\r\n旧二\r\n', after: '中间\r\n' })] },
  { toolResults: [result({ path: 'd:/work/窗口.epl', before: '中间\r\n', after: '首行\r\n新一\r\n新二\r\n' }),
    result({ path: 'D:/work/新建.epl', before: null, after: '新建\n' }),
    result({ path: 'D:/work/失败.epl', before: null, after: '不应出现' }, false)] },
] };
const changes = turnChanges(trace);
assert.equal(changes.length, 2, 'case/separator aliases must merge, failures must be excluded');
assert.equal(changes[0].before, '首行\r\n旧一\r\n旧二\r\n');
assert.equal(changes[0].after, '首行\r\n新一\r\n新二\r\n');
assert.equal(changes[1].before, null, 'new files retain an absent baseline');
const rows = comparisonRows(changes[0]);
assert(rows);
assert.deepEqual(rows.map(row => [row.oldLine, row.newLine]), [[1, 1], [2, 2], [3, 3]]);
const unified = unifiedRows(rows);
assert.deepEqual(unified.slice(1).map(row => row.before === undefined ? 'add' : 'del'), ['del', 'del', 'add', 'add']);
for (const change of changes) {
  const view = comparisonRows(change);
  // Reconstruct both actual sources from numbered rows, preserving CRLF text.
  assert.equal(view.filter(row => row.before !== undefined).map(row => row.before).join('\n') + (change.before?.endsWith('\n') ? '\n' : ''), change.before ?? '');
  assert.equal(view.filter(row => row.after !== undefined).map(row => row.after).join('\n') + (change.after.endsWith('\n') ? '\n' : ''), change.after);
}
assert.equal(turnChanges({ steps: [{ toolResults: [result({ path: 'same', before: 'x', after: 'y' }), result({ path: 'same', before: 'y', after: 'x' })] }] }).length, 0, 'reverted files have no net diff');
assert.deepEqual(comparisonRows({ path: 'empty', before: '', after: '' }), []);
console.log('PASS turn-start/end snapshots, path aliases, failed/reverted edits, CRLF line reconstruction and unified/split ordering');
