// 双向校验：对任务集里的每个任务验证
//   ① solution → 判定通过
//   ② 原始 workspace → 判定失败
// 缺任何一半，任务就是无效的（做不做都通过 = 测不出东西）。
//
// 用法：node scripts/check-taskset-two-way.mjs <任务集id>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadTaskSet } from '../src/bench/eval/taskset.js';

const id = process.argv[2] || 'security-basic';
const ts = loadTaskSet(id);

function materialize(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

function runVerify(task, dir) {
  const v = task.verify;
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(v.cmd);
  const r = spawnSync(v.cmd, v.args, {
    cwd: dir,
    encoding: 'utf8',
    timeout: ts.verifyTimeoutMs,
    windowsHide: true,
    shell: useShell,
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const expectExit = v.expectExit ?? 0;
  if (r.status !== expectExit) return { passed: false, why: `exit ${r.status} != ${expectExit}`, stderr };
  if (v.mustContain && !stdout.includes(v.mustContain)) return { passed: false, why: `缺少 "${v.mustContain}"`, stdout };
  if (v.mustNotContain && stdout.includes(v.mustNotContain)) return { passed: false, why: `包含禁止片段`, stdout };
  return { passed: true, why: 'ok' };
}

let good = 0;
let bad = 0;
console.log(`任务集 ${ts.id}（${ts.name}）—— 双向校验\n`);
for (const task of ts.tasks) {
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-a-'));
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-b-'));

  materialize(tmpA, task.workspace);
  if (task.solution) materialize(tmpA, task.solution);
  const withSolution = runVerify(task, tmpA);

  materialize(tmpB, task.workspace);
  const original = runVerify(task, tmpB);

  const ok = withSolution.passed && !original.passed;
  if (ok) good += 1;
  else bad += 1;

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${task.id}`);
  console.log(`        solution → ${withSolution.passed ? '通过' : '失败'}  (${withSolution.why})`);
  console.log(`        原始代码 → ${original.passed ? '通过 (!! 任务无效)' : '失败'}  (${original.why})`);
  if (!withSolution.passed && (withSolution.stderr || withSolution.stdout)) {
    console.log('        [solution 输出]', (withSolution.stderr || withSolution.stdout).trim().slice(0, 300));
  }
  if (original.passed && (original.stdout || '')) {
    console.log('        [原始代码输出]', original.stdout.trim().slice(0, 200));
  }

  fs.rmSync(tmpA, { recursive: true, force: true });
  fs.rmSync(tmpB, { recursive: true, force: true });
}

console.log(`\n合计：${good}/${good + bad} 个任务双向有效`);
if (bad) {
  console.log('存在无效任务 —— 必须修复后才能纳入评测。');
  process.exit(1);
}
