import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

const compiled = await build({ entryPoints: ['src/lib/code-highlight.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { CodeHighlightCache } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const highlighter = await createHighlighterCore({
  themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
  langs: [import('shiki/langs/javascript.mjs'), import('shiki/langs/json.mjs')],
  engine: createOnigurumaEngine(import('shiki/wasm')),
});
const cache = new CodeHighlightCache();
const comparable = lines => lines.map(line => line.map(({ content, color, fontStyle }) => ({ content, color, fontStyle })));
try {
  for (const source of [
    'const text = `窗口\n按钮 ${1 + 2}\n结束`;\n/* 多行\n注释 */\nconsole.log(text);',
    'const text = "窗口";\r\n\r\n// 事件\r\nconsole.log(text);',
    '\n\nconst value = 42;\n',
  ]) {
    for (let index = 1; index <= source.length; index++) {
      const code = source.slice(0, index);
      const actual = cache.update(highlighter, code, 'javascript', 'github-light');
      const expected = highlighter.codeToTokensBase(code, { lang: 'javascript', theme: 'github-light' });
      assert.deepEqual(comparable(actual), comparable(expected), 'token mismatch at ' + JSON.stringify(code));
    }
  }
  const first = cache.update(highlighter, 'const one = 1;\nconst two = ', 'javascript', 'github-light');
  const second = cache.update(highlighter, 'const one = 1;\nconst two = 2;', 'javascript', 'github-light');
  assert.equal(second[0], first[0], 'completed lines must retain their token arrays');
  for (const [code, lang, theme] of [
    ['{"窗口": true}', 'json', 'github-dark'],
    ['const replaced = false;', 'javascript', 'github-light'],
    ['<unknown-language>', 'unsupported-fixture', 'github-dark'],
  ]) {
    assert.deepEqual(comparable(cache.update(highlighter, code, lang, theme)), comparable(highlighter.codeToTokensBase(code, { lang: lang === 'unsupported-fixture' ? 'text' : lang, theme })));
  }
  console.log('PASS incremental highlighting equals full tokenization across split lines, CRLF, template strings, comments, replacements, language and theme changes');
} finally { highlighter.dispose(); }
