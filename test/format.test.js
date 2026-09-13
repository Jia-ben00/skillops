import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkill } from '../src/skillfile.js';
import { isSkillDir } from '../src/util.js';
import { scanSmartDir, scan } from '../src/scanner.js';

const FIX_CURSOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures-cursor');

test('cursor-rule（.mdc）解析为统一模型', () => {
  const dir = path.join(FIX_CURSOR, 'frontend-rules');
  assert.ok(isSkillDir(dir), '含 .mdc 的目录应被识别为技能目录');
  const s = parseSkill(dir);
  assert.equal(s.format, 'cursor-rule');
  assert.equal(s.toolHint, 'cursor');
  assert.equal(s.name, 'frontend-rules');
  assert.ok(s.hasDescription);
  assert.ok(s.listingTax > 0 && s.triggerTax > 0);
  assert.ok(s.globs, '应解析 globs');
});

test('scanSmartDir 同时发现 SKILL.md 与 .mdc 技能', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures-cursor');
  const skills = scanSmartDir(dir, 'test');
  assert.equal(skills.length, 1);
  assert.equal(skills[0].format, 'cursor-rule');
});

test('统一模型可进入体检与评分', async () => {
  const { runAnalysis } = await import('../src/analyzers/index.js');
  const { loadConfig } = await import('../src/scanner.js');
  const skills = scan([{ dir: FIX_CURSOR, source: 'test' }]);
  const a = runAnalysis(skills, loadConfig(FIX_CURSOR));
  assert.equal(a.totals.skillCount, 1);
  const s = a.skills[0];
  assert.ok(s.score >= 80, `cursor 规则健康分应较高，实际 ${s.score}`);
});
