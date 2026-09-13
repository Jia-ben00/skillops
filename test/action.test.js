import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initTeamRepo, pushSkills } from '../src/sync.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE_JS = path.join(ROOT, '.github', 'actions', 'skill-gate', 'gate.cjs');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
let tmp;
test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-action-'));
});
test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runGate(cwd) {
  try {
    const out = execFileSync(process.execPath, [GATE_JS, 'skills', '.skillops/registry.json', 'true'], { cwd, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

test('skill-gate 正例：registry 与 skills 一致时通过', () => {
  const repo = path.join(tmp, 'team');
  initTeamRepo(repo);
  pushSkills(repo, FIX, { apply: true });
  const { code, out } = runGate(repo);
  assert.equal(code, 0, out);
  assert.match(out, /门禁通过/);
});

test('skill-gate 负例：版本落后时退出码 1（拦截）', () => {
  const repo = path.join(tmp, 'team-stale');
  initTeamRepo(repo);
  pushSkills(repo, FIX, { apply: true });
  const skillMd = path.join(repo, 'skills', 'good-skill', 'SKILL.md');
  let content = fs.readFileSync(skillMd, 'utf8');
  content = content.replace(/^version: .*$/m, 'version: 0.0.1');
  fs.writeFileSync(skillMd, content, 'utf8');
  const { code, out } = runGate(repo);
  assert.equal(code, 1, '版本落后必须拦截');
  assert.match(out, /门禁未通过/);
});

test('skill-gate 负例：缺 registry.json 时报错', () => {
  const empty = path.join(tmp, 'no-registry');
  fs.mkdirSync(empty, { recursive: true });
  const { code, out } = runGate(empty);
  assert.equal(code, 1);
  assert.match(out, /未找到/);
});
