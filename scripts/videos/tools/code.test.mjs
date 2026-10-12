import assert from 'node:assert/strict';
import test from 'node:test';
import { locate, tokenize } from '../src/lesson-kit/code.ts';

const kinds = (line) => line.filter((t) => t.text.trim()).map((t) => [t.text.trim(), t.kind]);

test('an entity reads like it does in Fabricator’s editor', () => {
  const [decorator, field, policy, klass] = tokenize(`@role('authenticated', '*', {
  @text({ max: 200 }) title!: string;
  policy: (claims, item) => claims.sub.eq(item.owner_id),
export class Expense {`);
  assert.deepEqual(kinds(decorator), [
    ['@role', 'decorator'],
    ['(', 'bracket'],
    ["'authenticated'", 'string'],
    [',', 'punct'],
    ["'*'", 'string'],
    [',', 'punct'],
    ['{', 'bracket'],
  ]);
  assert.deepEqual(kinds(field), [
    ['@text', 'decorator'],
    ['(', 'bracket'],
    ['{', 'bracket'],
    ['max', 'property'],
    [':', 'punct'],
    ['200', 'number'],
    ['}', 'bracket'],
    [')', 'bracket'],
    ['title', 'property'],
    ['!:', 'punct'],
    ['string', 'keyword'],
    [';', 'punct'],
  ]);
  const p = kinds(policy);
  assert.deepEqual(p[0], ['policy', 'property']);
  assert.deepEqual(
    p.filter(([, k]) => k === 'property' || k === 'function').map(([t]) => t),
    ['policy', 'sub', 'eq', 'owner_id'],
  );
  assert.deepEqual(kinds(klass), [
    ['export', 'keyword'],
    ['class', 'keyword'],
    ['Expense', 'type'],
    ['{', 'bracket'],
  ]);
});

test('brackets are colored by how deeply they nest', () => {
  const [line] = tokenize('a({ b: [1] })');
  const depths = line.filter((t) => t.kind === 'bracket').map((t) => [t.text, t.depth]);
  assert.deepEqual(depths, [
    ['(', 0],
    ['{', 1],
    ['[', 2],
    [']', 2],
    ['}', 1],
    [')', 0],
  ]);
});

test('comments and strings win over everything inside them', () => {
  const [a, b, c] = tokenize("const s = '@entity() // no'; // @role\n/* a\nclass */ x");
  assert.deepEqual(kinds(a).slice(-3), [
    ["'@entity() // no'", 'string'],
    [';', 'punct'],
    ['// @role', 'comment'],
  ]);
  assert.deepEqual(kinds(b), [['/* a', 'comment']]);
  assert.deepEqual(kinds(c), [
    ['class */', 'comment'],
    ['x', 'plain'],
  ]);
});

test('locate finds text by line and column, or says it is gone', () => {
  const code = 'one\n  two two\nthree';
  assert.deepEqual(locate(code, 'two'), { line: 2, from: 2, to: 5 });
  assert.deepEqual(locate(code, 'two', 2), { line: 2, from: 6, to: 9 });
  assert.throws(() => locate(code, 'four'), /"four" \(#1\) isn't in the snippet/);
});
