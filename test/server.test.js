import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
let base;
let server;
test.before(async () => {
  process.env.SKILLOPS_REPORT_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-reports-')));
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  fs.rmSync(process.env.SKILLOPS_REPORT_DIR, { recursive: true, force: true });
});

test('GET / 返回控制台 SPA', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /SkillOps 控制台/);
  assert.match(text, /治理建议/);
});

test('GET /api/health 返回版本与默认目录', async () => {
  const j = await (await fetch(`${base}/api/health`)).json();
  assert.equal(j.ok, true);
  assert.ok(j.version);
  assert.ok(j.skillsDir);
});

test('GET /api/skills?dir= 返回轻量列表', async () => {
  const j = await (await fetch(`${base}/api/skills?dir=${encodeURIComponent(FIX)}`)).json();
  assert.equal(j.skills.length, 7);
  assert.ok(j.skills.every((s) => typeof s.score === 'number'));
});

test('POST /api/doctor 完整体检', async () => {
  const r = await fetch(`${base}/api/doctor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skillsRoot: FIX }),
  });
  const j = await r.json();
  assert.equal(j.totals.skillCount, 7);
  assert.ok(j.score > 0 && j.score <= 100);
  assert.ok(Array.isArray(j.issues) && Array.isArray(j.suggestions));
});

test('POST /api/fix/plan 返回 dry-run 治理计划', async () => {
  const r = await fetch(`${base}/api/fix/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skillsRoot: FIX, target: 'bloated-skill' }),
  });
  const j = await r.json();
  assert.ok(Array.isArray(j.plan));
  assert.ok(j.plan.every((p) => p.action === 'disable' || p.action === 'update'));
  assert.ok(j.suggestions.some((s) => s.skill === 'bloated-skill'), 'suggestions 应包含目标技能');
  // 无 target 时返回全部可执行项
  const r2 = await fetch(`${base}/api/fix/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skillsRoot: FIX }),
  });
  const j2 = await r2.json();
  assert.ok(j2.plan.length >= j.plan.length);
});

test('POST /api/fix/apply 执行 disable 到副本（落盘可逆）', async () => {
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-fix-')), 'skills');
  fs.cpSync(FIX, copy, { recursive: true });
  const r = await fetch(`${base}/api/fix/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skillsRoot: copy, items: [{ action: 'disable', skill: 'bloated-skill' }] }),
  });
  const j = await r.json();
  assert.equal(j.appliedCount, 1);
  assert.ok(j.changed.some((c) => c.result.includes('bloated-skill.disabled')));
  assert.ok(fs.existsSync(path.join(copy, 'bloated-skill.disabled')), '*.disabled 应存在');
  fs.rmSync(path.dirname(copy), { recursive: true, force: true });
});

test('POST /api/fix/apply 拒绝未知动作与外部技能名', async () => {
  const r = await fetch(`${base}/api/fix/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skillsRoot: FIX, items: [{ action: 'rm-rf', skill: 'bloated-skill' }, { action: 'disable', skill: '../../etc/passwd' }] }),
  });
  const j = await r.json();
  assert.equal(j.appliedCount, 0, '非法动作/非法技能名应被过滤');
});

test('GET /api/report 生成报告文件', async () => {
  const r = await fetch(`${base}/api/report?dir=${encodeURIComponent(FIX)}`);
  const j = await r.json();
  assert.ok(j.name.endsWith('.html'));
  assert.ok(fs.existsSync(j.path));
  const view = await fetch(`${base}/reports/${encodeURIComponent(j.name)}`);
  assert.equal(view.status, 200);
  assert.match(await view.text(), /SkillOps/);
});

test('/reports/ 路径穿越防护', async () => {
  const r = await fetch(`${base}/reports/../package.json`);
  assert.equal(r.status, 404);
});
