'use strict';
// Phase 1 checks: the server has no dependencies, and data/ is never staged in the template repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const inRepo = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });

test('package.json declares no dependencies of any kind', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies']) {
    assert.ok(!pkg[k] || Object.keys(pkg[k]).length === 0, `${k} must be empty`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'package-lock.json')), 'no lock file: nothing to install');
  assert.ok(!fs.existsSync(path.join(ROOT, 'node_modules')), 'no node_modules');
});

test('every require() in the server and the shared format is built into Node or a local file', () => {
  const files = ['server/hq.js', 'app/format.js'];
  const builtin = new Set(builtinModules);
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const found = [...src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const name of found) {
      const ok = name.startsWith('.') || name.startsWith('node:') || builtin.has(name);
      assert.ok(ok, `${f} requires "${name}", which is not built into Node`);
      if (name.startsWith('.')) assert.ok(fs.existsSync(path.resolve(ROOT, path.dirname(f), name)), `${f}: ${name} exists`);
    }
    assert.doesNotMatch(src, /\bimport\s.+from\s+['"](?!node:|\.)/, `${f} has no package imports`);
  }
});

test('data/ is git-ignored by the template repo, and nothing under it is tracked', () => {
  for (const p of ['data/', 'data/projects.md', 'data/projects/x/tickets/T-001.md', 'data/.git/HEAD']) {
    assert.doesNotThrow(() => inRepo('check-ignore', '-q', '--no-index', p), `${p} should be ignored`);
  }
  assert.equal(inRepo('ls-files', '--', 'data').trim(), '', 'no tracked files under data/');
  assert.equal(inRepo('ls-files', '--cached', '--', 'data').trim(), '', 'nothing staged under data/');
});
