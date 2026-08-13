import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('./greeter.mjs', import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

test('valid name prints greeting and exits 0', () => {
  const result = runCli(['--name', 'Ada']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Hello, Ada!\n');
});

test('missing --name exits 2 with non-empty stderr', () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.length > 0);
});

test('empty --name exits 2 with non-empty stderr', () => {
  const emptyResult = runCli(['--name', '']);
  assert.equal(emptyResult.status, 2);
  assert.ok(emptyResult.stderr.length > 0);

  const whitespaceResult = runCli(['--name', '   ']);
  assert.equal(whitespaceResult.status, 2);
  assert.ok(whitespaceResult.stderr.length > 0);
});

test('unknown option exits 2 with non-empty stderr', () => {
  const result = runCli(['--bogus']);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.length > 0);
});

test('name with surrounding whitespace is trimmed', () => {
  const result = runCli(['--name', '  Ada  ']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Hello, Ada!\n');
});

test('--shout is treated as an unknown option in this pass', () => {
  const result = runCli(['--shout', '--name', 'Ada']);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.length > 0);
});
