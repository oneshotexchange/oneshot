import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL('../../../vendor/decode-uri-component/index.cjs', import.meta.url));
const decode = require(entry) as (input: unknown) => string;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// Vectors derived from upstream v0.5.0/test.js, MIT copyright Sam Verschueren.
// Its original notice is preserved in vendor/decode-uri-component/LICENSE.
const vectors: [string, string][] = [
  ['', ''], ['test', 'test'], ['a+b', 'a+b'], ['a+b+c+d', 'a+b+c+d'],
  ['%', '%'], ['%25', '%'], ['%%25%%', '%%%%'], ['%20', ' '], ['%2B', '+'],
  ['%00', '\0'], ['%7F', '\u007F'], ['%09', '\t'], ['%0A', '\n'], ['%0D%0A', '\r\n'],
  ['%61%62%63', 'abc'], ['%2F%3F%23', '/?#'], ['%61+%4d%4D', 'a+MM'],
  ['st%C3%A5le', 'ståle'], ['st%C3%A5le%', 'ståle%'], ['%st%C3%A5le%', '%ståle%'],
  ['%%7Bst%C3%A5le%7D%', '%{ståle}%'], ['%ab%C3%A5le%', '%abåle%'], ['%C3%A5%able%', 'å%able%'],
  ['%7B%ab%7C%de%7D', '{%ab|%de}'], ['%7B%ab%%7C%de%%7D', '{%ab%|%de%}'],
  ['%EF%BB%BFtest', '\uFEFFtest'], ['%FE%FF', '\uFFFD\uFFFD'], ['%FF%FE', '\uFFFD\uFFFD'],
  ['%C2', '\uFFFD'], ['%C2x', '\uFFFDx'], ['%C2%B5', 'µ'], ['%C2%41', '\uFFFDA'],
  ['%C2%C2%B5', '\uFFFDµ'], ['%%C2%%', '%\uFFFD%%'], ['%ea%ba%5a%ba', '%ea%baZ%ba'],
  ['%C3%5A%A5', '%C3Z%A5'], ['%C3%5A%A5%AB', '%C3Z%A5%AB'],
  ['%F4%8F%BF%BF', '\u{10FFFF}'], ['%ED%9F%BF', '\u{D7FF}'],
  ['%F0%9F%98%80%F0%9F%98%81', '😀😁'], ['%E4%BD%A0%E5%A5%BD', '你好'], ['%F0%9D%84%9E', '𝄞'],
  ['%F0%9F%98', '%F0%9F%98'], ['%F0%9F', '%F0%9F'], ['%F0', '%F0'],
  ['%F0%9F%41', '%F0%9FA'], ['%F0%41%82%83', '%F0A%82%83'],
  ['%F5%80%80%80', '%F5%80%80%80'], ['%F8%88%88%88', '%F8%88%88%88'],
  ['%C0%AF', '%C0%AF'], ['%C1%BF', '%C1%BF'], ['%E2%82%AC', '€'],
  ['%E2%82', '%E2%82'], ['%E2%41%AC', '%E2A%AC'], ['%E0%80%41', '%E0%80A'],
  ['%ED%A0%80', '%ED%A0%80'], ['%80', '%80'], ['%BF', '%BF'], ['%C3', '%C3'],
  ['%C3%41', '%C3A'], ['%F0%9F%98%80%ab', '😀%ab'], ['%C3%A5%ab', 'å%ab'],
  ['%E0%80%80', '%E0%80%80'], ['%F0%80%80%80', '%F0%80%80%80'],
  ['%ED%BF%BF', '%ED%BF%BF'], ['%F4%90%80%80', '%F4%90%80%80'],
  ['%G0', '%G0'], ['%0G', '%0G'], ['%GG', '%GG'], ['foo%bar', 'foo%bar'], ['%u0041', '%u0041'],
  ['%C3%A5%80%C3%A5', 'å%80å'], ['%G0%C3%A5%ab', '%G0å%ab'],
  ['%C3%A5%%C3%A5', 'å%å'], ['a%FE%FFb', 'a\uFFFD\uFFFDb'],
  ['%252525', '%2525'], ['%%%','%%%'], ['%25C2%25', '%C2%'], ['%2525C2', '%25C2'],
  ['%84%D7%25%88%90', '%84%D7%%88%90'], ['%20%20%25%80', '  %%80'],
];

describe('local upstream decoder CommonJS backport', () => {
  it('exports a callable CommonJS function with an honest private package version', () => {
    expect(typeof decode).toBe('function');
    const manifest = JSON.parse(readFileSync(new URL('../../../vendor/decode-uri-component/package.json', import.meta.url), 'utf8'));
    expect(manifest).toMatchObject({ name: 'decode-uri-component', version: '0.5.0+oneshot.cjs.1', private: true, type: 'commonjs', main: './index.cjs' });
  });

  it('preserves upstream source and license bytes apart from the one export adaptation', () => {
    const source = readFileSync(entry, 'utf8');
    expect(digest(source)).toBe('684ba79779327ba789733a3a563050370a928a57eb7dd33d19b346f43b32cbb7');
    const upstream = source.replace('module.exports = function decodeUriComponent(encodedURI) {', 'export default function decodeUriComponent(encodedURI) {');
    expect(digest(upstream)).toBe('9401353df38f8010ad7035fe8d666bce6a4902bc1cff809afc4ab23fa2e0bdaa');
    expect(digest(readFileSync(new URL('../../../vendor/decode-uri-component/LICENSE', import.meta.url))))
      .toBe('ed7a9a0f74e43951b2520efe1a4349cb9ed5f3dff0b0f268e2e51a4d38df7ea4');
  });

  it.each(vectors)('follows upstream decoding %s', (input, expected) => {
    expect(decode(input)).toBe(expected);
  });

  it('rejects non-string values without coercion and decodes exactly one level', () => {
    for (const input of [undefined, null, 5, true, {}, [], Symbol('x'), 0n, Object('test'), { toString: () => 'test%20' }]) {
      expect(() => decode(input)).toThrow(TypeError);
    }
    expect(decode('%2525')).toBe('%25');
    expect(decode('%25')).toBe('%');
  });

  it('completes long malformed UTF-8 runs within an isolated process deadline', () => {
    const script = [
      "const decode = require(process.argv[1]);",
      "const start = performance.now();",
      "for (const prefix of ['%ED%A0%80'.repeat(4096), '%C3'.repeat(8192), '%C0%AF'.repeat(4096)]) {",
      "  if (decode(prefix + '%41') !== prefix + 'A') throw new Error('malformed-run output changed');",
      "}",
      "console.log(JSON.stringify({ elapsed: performance.now() - start }));",
    ].join('\n');
    // A vulnerable decoder cannot hang the test worker: the child is killed at 3 seconds.
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script, entry], { timeout: 3_000, encoding: 'utf8', windowsHide: true }));
    expect(result.elapsed).toBeLessThan(2_500);
  });

  it('preserves query-string 7 query decoding and documents the upstream literal-plus fragment behavior', () => {
    const queryEntry = require.resolve('query-string');
    const upstreamRequire = createRequire(queryEntry);
    const queryManifest = JSON.parse(readFileSync(upstreamRequire.resolve('./package.json'), 'utf8'));
    expect(queryManifest.version).toBe('7.1.3');
    const localModule = { exports: {} as Record<string, unknown> };
    const injectedRequire = (name: string) => name === 'decode-uri-component' ? decode : upstreamRequire(name);
    // Evaluate the installed, unmodified CJS consumer with a test-local dependency
    // binding; do not change installed packages, global require hooks or module cache.
    compileFunction(readFileSync(queryEntry, 'utf8'), ['require', 'module', 'exports'], { filename: queryEntry })
      (injectedRequire, localModule, localModule.exports);
    const query = localModule.exports as unknown as {
      parse(value: string, options?: { arrayFormat: 'comma' }): Record<string, unknown>;
      parseUrl(value: string, options: { parseFragmentIdentifier: boolean }): { query: Record<string, unknown>; fragmentIdentifier: string };
    };
    expect(query.parse('name=a+b&literal=%2B&utf8=%C3%A5&broken=%C3%41&percent=%25'))
      .toEqual({ name: 'a b', literal: '+', utf8: 'å', broken: '%C3A', percent: '%' });
    expect(query.parseUrl('https://example.com/?name=a+b#a+b', { parseFragmentIdentifier: true }))
      .toMatchObject({ query: { name: 'a b' }, fragmentIdentifier: 'a+b' });
    // An encoded separator causes this consumer to decode a component twice.
    // Follow upstream 0.5.0: a newly decoded literal plus stays plus on pass two.
    expect(query.parse('items=%2B%2Ca+b', { arrayFormat: 'comma' })).toEqual({ items: ['+', 'a b'] });
  });
});
