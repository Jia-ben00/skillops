import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSuites, loadSuite } from '../src/bench/suite.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('SkillBench 扩展：docs/codegen 套件可加载', () => {
  const ids = listSuites();
  assert.ok(ids.includes('basic'));
  assert.ok(ids.includes('docs'));
  assert.ok(ids.includes('codegen'));
  const docs = loadSuite('docs');
  assert.ok(docs.agentTask && docs.checks.length > 0);
  const weightSum = docs.checks.reduce((a, c) => a + c.weight, 0);
  assert.equal(weightSum, 100);
  const codegen = loadSuite('codegen');
  assert.equal(codegen.checks.reduce((a, c) => a + c.weight, 0), 100);
});

test('codegen 套件跑通 fixtures（good > risky）', () => {
  const out = execFileSync(process.execPath, [CLI, 'bench', FIX, '--no-defaults', '--suite', 'codegen', '--json'], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.ok(Array.isArray(r.results));
  const byName = Object.fromEntries(r.results.map((x) => [x.skill, x]));
  assert.ok(byName['good-skill'].score > byName['risky-skill'].score, `good(${byName['good-skill'].score}) 应高于 risky(${byName['risky-skill'].score})`);
});

test('docs 套件跑通 fixtures', () => {
  const out = execFileSync(process.execPath, [CLI, 'bench', FIX, '--no-defaults', '--suite', 'docs', '--json'], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.results.length, 7);
  for (const x of r.results) {
    assert.ok(x.score >= 0 && x.score <= 100);
  }
});
