import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, loadConfig } from '../src/scanner.js';
import { runAnalysis } from '../src/analyzers/index.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function analyzeFixtureDir(dir = FIX, config = loadConfig(dir)) {
  const { skills } = { skills: scan([{ dir, source: 'test' }]) };
  return runAnalysis(skills, config);
}

test('体检发现：超长描述/超长正文/内联脚本（bloated-skill）', () => {
  const a = analyzeFixtureDir();
  const ids = a.issues.filter((i) => i.skill === 'bloated-skill').map((i) => i.id);
  assert.ok(ids.includes('CONTEXT_DESC_OVER'), `缺少 CONTEXT_DESC_OVER: ${ids}`);
  assert.ok(ids.includes('CONTEXT_LINES_OVER'), `缺少 CONTEXT_LINES_OVER: ${ids}`);
  assert.ok(ids.includes('CONTEXT_INLINE_SCRIPT'), `缺少 CONTEXT_INLINE_SCRIPT: ${ids}`);
  const s = a.skills.find((x) => x.name === 'bloated-skill');
  assert.ok(s.score < 75, `超长技能评分应偏低，实际 ${s.score}`);
});

test('体检发现：只读/写入工作流冲突（migrate-read ↔ migrate-write）', () => {
  const a = analyzeFixtureDir();
  const conflict = a.issues.find((i) => i.id === 'WORKFLOW_CONFLICT');
  assert.ok(conflict, '应检出 WORKFLOW_CONFLICT');
  assert.equal(conflict.severity, 'error');
  assert.ok(a.pairs.some((p) => p.type === 'workflow-conflict'), 'pairs 应含 workflow-conflict');
});

test('体检发现：高度重复（dup-a ↔ dup-b）', () => {
  const a = analyzeFixtureDir();
  assert.ok(a.issues.some((i) => i.id === 'DUPLICATE'), '应检出 DUPLICATE');
});

test('体检发现：危险脚本启发式（risky-skill）', () => {
  const a = analyzeFixtureDir();
  const ids = a.issues.filter((i) => i.skill === 'risky-skill').map((i) => i.id);
  assert.ok(ids.includes('RISKY_PIPE_SHELL'), `缺少 RISKY_PIPE_SHELL: ${ids}`);
  assert.ok(ids.includes('RISKY_RM_RF'), `缺少 RISKY_RM_RF: ${ids}`);
});

test('健康技能评分高且无 error', () => {
  const a = analyzeFixtureDir();
  const s = a.skills.find((x) => x.name === 'good-skill');
  assert.ok(s.score >= 90, `good-skill 应 ≥90，实际 ${s.score}`);
  assert.ok(!a.issues.some((i) => i.skill === 'good-skill' && i.severity === 'error'));
});

test('过期检测：mtime 超过阈值 → STALE', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-stale-'));
  const dir = path.join(tmp, 'old-skill');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: old-skill\ndescription: 处理旧规则检查\n---\n# old\n', 'utf8');
  const old = Date.now() - 200 * 86400000;
  fs.utimesSync(dir, new Date(old), new Date(old));
  const skills = scan([{ dir: tmp, source: 'test' }]);
  const config = loadConfig(tmp);
  const a = runAnalysis(skills, config);
  assert.ok(a.issues.some((i) => i.id === 'STALE' && i.skill === 'old-skill'), '应检出 STALE');
  fs.rmSync(tmp, { recursive: true, force: true });
});
