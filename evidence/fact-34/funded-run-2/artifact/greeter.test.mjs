import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'greeter.mjs');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('--name Ada prints greeting and exits 0', () => {
  const result = run(['--name', 'Ada']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Hello, Ada!\n');
  assert.equal(result.stderr, '');
});

test('name with surrounding whitespace is trimmed', () => {
  const result = run(['--name', '  Ada  ']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Hello, Ada!\n');
});

test('missing --name exits 2 with a stderr message', () => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.length > 0, 'expected an error message on stderr');
});

test('empty --name exits 2 with a stderr message', () => {
  const result = run(['--name', '   ']);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.length > 0, 'expected an error message on stderr');
});

test('unknown option exits 2 with a stderr message', () => {
  const result = run(['--name', 'Ada', '--shout']);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.length > 0, 'expected an error message on stderr');
});
