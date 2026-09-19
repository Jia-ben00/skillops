import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadTaskSet,
  listTaskSets,
  validateTaskSet,
  TASKS_DIR,
} from '../src/bench/eval/taskset.js';
import { buildSkillContext, resolveBackend, deterministicRoll } from '../src/bench/eval/agent.js';
import { runEval, runVerifier } from '../src/bench/eval/runner.js';
import { buildEvalReport } from '../src/bench/eval/report.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');

/** 构造一个测试用技能对象（不必落在磁盘上） */
function fakeSkill(name, desc, body) {
  return {
    name,
    description: desc,
    body,
    dir: `/fake/${name}`,
    format: 'agent-skill',
    listingTax: 20,
    triggerTax: 60,
  };
}

// ---------------------------------------------------------------------------
// 任务集加载与校验
// ---------------------------------------------------------------------------

test('内置任务集 codegen-basic 可加载且任务齐全', () => {
  const ids = listTaskSets();
  assert.ok(ids.includes('codegen-basic'), `内置任务集应含 codegen-basic，实际 ${ids.join(',')}`);
  const ts = loadTaskSet('codegen-basic');
  assert.equal(ts.id, 'codegen-basic');
  assert.equal(ts.tasks.length, 5);
  assert.equal(ts.verifyTimeoutMs, 15000);
  for (const t of ts.tasks) {
    assert.ok(t.prompt, `${t.id} 应有 prompt`);
    assert.ok(Object.keys(t.workspace).length, `${t.id} 应有初始工作区`);
    assert.ok(t.verify.cmd, `${t.id} 应有判定命令`);
    assert.ok(Array.isArray(t.verify.args), `${t.id} 判定参数应为数组`);
  }
});

test('每个任务都必须有可自动判定的 verification（不允许人工判断）', () => {
  const ts = loadTaskSet('codegen-basic');
  for (const t of ts.tasks) {
    // 判定必须落到「命令 + 退出码/输出断言」上
    assert.equal(typeof t.verify.cmd, 'string');
    assert.ok(Array.isArray(t.verify.args) && t.verify.args.length > 0);
    const hasAssertion =
      t.verify.expectExit !== undefined ||
      Boolean(t.verify.mustContain) ||
      Boolean(t.verify.mustNotContain);
    assert.ok(hasAssertion, `${t.id} 必须有至少一种客观断言（退出码或输出片段）`);
  }
});

test('任务集校验会拒绝非法定义', () => {
  const base = {
    id: 'x',
    tasks: [
      {
        id: 'a',
        prompt: 'p',
        workspace: { 'a.js': 'x' },
        verify: { cmd: 'node', args: ['-e', '0'] },
      },
    ],
  };
  assert.ok(validateTaskSet(base, 'inline'));

  assert.throws(() => validateTaskSet({ ...base, tasks: [] }, 'inline'), /非空/);
  assert.throws(() => validateTaskSet({ ...base, id: undefined }, 'inline'), /缺少 id/);
  assert.throws(
    () => validateTaskSet({ id: 'y', tasks: [{ ...base.tasks[0], verify: undefined }] }, 'inline'),
    /缺少 verify/,
  );
  assert.throws(
    () => validateTaskSet({ id: 'y', tasks: [{ ...base.tasks[0], verify: { cmd: 'n' } }] }, 'inline'),
    /args 必须是数组/,
  );
  assert.throws(
    () => validateTaskSet({ id: 'y', tasks: [{ ...base.tasks[0], workspace: { '../evil': 'x' } }] }, 'inline'),
    /不得越界/,
  );
  assert.throws(
    () => validateTaskSet({ id: 'y', tasks: [base.tasks[0], base.tasks[0]] }, 'inline'),
    /重复任务 id/,
  );
});

test('内置任务集 security-basic 可加载且任务齐全', () => {
  const ids = listTaskSets();
  assert.ok(ids.includes('codegen-basic'), `内置任务集应含 codegen-basic，实际 ${ids.join(',')}`);
  assert.ok(ids.includes('security-basic'), `内置任务集应含 security-basic，实际 ${ids.join(',')}`);

  const ts = loadTaskSet('security-basic');
  assert.equal(ts.id, 'security-basic');
  assert.equal(ts.tasks.length, 5);
  assert.equal(ts.verifyTimeoutMs, 15000);
  for (const t of ts.tasks) {
    assert.ok(t.prompt, `${t.id} 应有 prompt`);
    assert.ok(Object.keys(t.workspace).length, `${t.id} 应有初始工作区`);
    assert.ok(t.verify.cmd, `${t.id} 应有判定命令`);
    assert.ok(Array.isArray(t.verify.args), `${t.id} 判定参数应为数组`);
  }
});

test('security-basic 覆盖安全评审的多个维度（不重复同一考点）', () => {
  const ts = loadTaskSet('security-basic');
  // 任务集若只考一个考点，不同技能之间就区分不出来；这里锁定考点的离散度。
  const ids = ts.tasks.map((t) => t.id).sort();
  assert.deepEqual(ids, [
    'path-traversal-guard',
    'redact-secret-in-log',
    'reject-weak-hash',
    'sql-string-concat',
    'verify-signature-not-bypassable',
  ]);
});

test('未知任务集会给出可用列表', () => {
  assert.throws(() => loadTaskSet('no-such-taskset'), /未知任务集/);
});

// ---------------------------------------------------------------------------
// 判定器：这是实验结论可信的前提
// ---------------------------------------------------------------------------

function tmpWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-verify-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

test('runVerifier：退出码相符且输出含必需片段时判通过', () => {
  const dir = tmpWith({ 'a.js': 'console.log("ok")' });
  const r = runVerifier({ cmd: 'node', args: ['a.js'], expectExit: 0, mustContain: 'ok' }, dir, 15000);
  assert.equal(r.passed, true, r.reason);
});

test('runVerifier：退出码不符时判失败并说明原因', () => {
  const dir = tmpWith({ 'a.js': 'process.exit(3)' });
  const r = runVerifier({ cmd: 'node', args: ['a.js'], expectExit: 0 }, dir, 15000);
  assert.equal(r.passed, false);
  assert.match(r.reason, /退出码/);
});

test('runVerifier：缺少必需输出片段时判失败', () => {
  const dir = tmpWith({ 'a.js': 'console.log("nope")' });
  const r = runVerifier({ cmd: 'node', args: ['a.js'], expectExit: 0, mustContain: 'fail 0' }, dir, 15000);
  assert.equal(r.passed, false);
  assert.match(r.reason, /未包含必需片段/);
});

test('runVerifier：出现禁止片段时判失败', () => {
  const dir = tmpWith({ 'a.js': 'console.log("SECRET leaked")' });
  const r = runVerifier({ cmd: 'node', args: ['a.js'], expectExit: 0, mustNotContain: 'SECRET' }, dir, 15000);
  assert.equal(r.passed, false);
  assert.match(r.reason, /禁止片段/);
});

test('runVerifier：命令超时被判定为失败而非挂死', () => {
  const dir = tmpWith({ 'a.js': 'setTimeout(() => {}, 60000)' });
  const r = runVerifier({ cmd: 'node', args: ['a.js'], expectExit: 0 }, dir, 700);
  assert.equal(r.passed, false);
  assert.match(r.reason, /超时/);
});

// ---------------------------------------------------------------------------
// 注入通道：A/B 的唯一自变量必须真实生效
// ---------------------------------------------------------------------------

test('buildSkillContext：只在传入技能时产出内容，且包含技能名与正文', () => {
  assert.equal(buildSkillContext(null), null);
  const ctx = buildSkillContext({ name: 'code-review', description: 'desc-x', body: 'BODY_MARKER' });
  assert.ok(ctx.includes('code-review'));
  assert.ok(ctx.includes('desc-x'));
  assert.ok(ctx.includes('BODY_MARKER'));
});

test('mock 后端：A 组能看到技能内容，B 组看不到（注入通道隔离）', async () => {
  const backend = resolveBackend('mock');
  const task = {
    id: 't1',
    skillTags: ['code-review'],
    workspace: {},
    solution: {},
  };
  const skill = fakeSkill('code-review', '代码审查', 'UNIQUE_BODY_TOKEN');

  const a = await backend.run({
    prompt: 'do it',
    skillContext: buildSkillContext(skill),
    task,
    arm: 'treatment',
    attempt: 0,
    applySolution: () => {},
  });
  const b = await backend.run({
    prompt: 'do it',
    skillContext: null,
    task,
    arm: 'control',
    attempt: 0,
    applySolution: () => {},
  });

  assert.ok(a._skillSeenByAgent.includes('UNIQUE_BODY_TOKEN'), 'A 组必须看到技能内容');
  assert.equal(b._skillSeenByAgent, null, 'B 组必须看不到任何技能内容');
  assert.equal(a.skillHit, true, 'A 组应识别为技能命中');
  assert.equal(b.skillHit, false, 'B 组无技能，不应命中');
});

test('mock 后端：种子包含 任务/分组/尝试次数，三者任一变化都会改变结果', () => {
  // 这是防回归测试：曾经因为种子只有 task.id，导致 A/B 两组取到同一随机数、lift 恒为 0。
  const a = deterministicRoll('t::treatment::0');
  const b = deterministicRoll('t::control::0');
  const c = deterministicRoll('t::treatment::1');
  const d = deterministicRoll('t::control::1');
  const set = new Set([a, b, c, d]);
  assert.equal(set.size, 4, `四个条件应产生不同随机数，实际 ${[...set].join(',')}`);
});

test('mock 后端：同一输入重复调用结果完全一致（可复现）', async () => {
  const backend = resolveBackend('mock');
  const task = { id: 't-repro', skillTags: ['x'], workspace: {}, solution: {} };
  const run = () =>
    backend.run({ prompt: 'p', skillContext: null, task, arm: 'control', attempt: 0, applySolution: () => {} });
  const r1 = await run();
  const r2 = await run();
  assert.equal(r1.exitCode, r2.exitCode);
  assert.equal(r1.stdout, r2.stdout);
});

// ---------------------------------------------------------------------------
// 端到端 A/B 实验
// ---------------------------------------------------------------------------

test('runEval：命中技能的 lift 显著高于不相关技能', async () => {
  const ts = loadTaskSet('codegen-basic');
  // 真实技能只对某个子集任务有效，而不是对全部任务都有效。
  // 这里 code-review 覆盖「修 bug / 重构 / 安全」三类任务，但不覆盖「补测试 / 实现去重」。
  const relevant = fakeSkill(
    'code-review',
    '代码审查与 bug 诊断',
    '用于 code-review、diagnosing-bugs、systematic-debugging、refactoring、security、shell-safety',
  );
  const irrelevant = fakeSkill('ppt-maker', '生成演示文稿', '用于制作 PPT 与幻灯片排版');

  const result = await runEval([relevant, irrelevant], ts, { repeat: 5, threshold: 10 });

  const byName = Object.fromEntries(result.skills.map((s) => [s.skill, s]));
  assert.ok(
    byName['code-review'].lift > byName['ppt-maker'].lift,
    `命中技能的 lift 应高于不相关技能：code-review=${byName['code-review'].lift} ppt-maker=${byName['ppt-maker'].lift}`,
  );
  assert.equal(byName['code-review'].verdict, 'useful');
  // 不相关技能会挤占上下文、干扰决策，因此不应被判为「有效」。
  // 平台把它判成 decorative 还是 harmful 取决于干扰强度，两者都说明「不该装」。
  assert.notEqual(byName['ppt-maker'].verdict, 'useful', '不相关技能不应被判为有效');
  assert.ok(byName['ppt-maker'].lift <= 0, `不相关技能不应产生正向提升，实际 ${byName['ppt-maker'].lift}`);
  // 逐任务看：命中的任务应有提升，未命中的任务无提升
  const hit = byName['code-review'].tasks.filter((t) => t.skillHit);
  const miss = byName['code-review'].tasks.filter((t) => !t.skillHit);
  assert.ok(hit.length > 0 && miss.length > 0, '应同时存在命中与未命中的任务，才构成有意义的对照');
  assert.ok(
    hit.some((t) => t.lift > 0),
    `至少一个命中任务应有正向提升：${hit.map((t) => `${t.taskId}=${t.lift}`).join(', ')}`,
  );
  assert.ok(
    miss.every((t) => t.lift <= 0),
    `未命中任务不应产生提升：${miss.map((t) => `${t.taskId}=${t.lift}`).join(', ')}`,
  );
});

test('runEval：结果结构完整，且 A/B 两组统计口径一致', async () => {
  const ts = loadTaskSet('codegen-basic');
  const skill = fakeSkill('code-review', '代码审查与 bug 诊断', 'code-review diagnosing-bugs');
  const result = await runEval([skill], ts, { repeat: 3 });

  assert.equal(result.kind, 'skillops-eval');
  assert.equal(result.backend, 'mock');
  assert.equal(result.taskset.taskCount, 5);
  assert.equal(result.config.repeat, 3);

  const s = result.skills[0];
  assert.equal(s.tasks.length, 5, '每个任务都应有一行结果');
  // 两组的总次数必须相同，否则通过率不可比
  assert.equal(s.treatment.total, s.control.total);
  assert.equal(s.treatment.total, 5 * 3);
  // lift 必须等于两组通过率之差（四舍五入到整数百分点）
  assert.equal(
    s.lift,
    Math.round((s.treatment.passed / s.treatment.total - s.control.passed / s.control.total) * 100),
  );
});

test('runEval：对照组结果跨技能共享（同一任务只跑一次裸跑）', async () => {
  const ts = loadTaskSet('codegen-basic');
  const s1 = fakeSkill('a-skill', 'x', 'code-review');
  const s2 = fakeSkill('b-skill', 'y', 'refactoring');
  const result = await runEval([s1, s2], ts, { repeat: 2 });
  const [first, second] = result.skills;
  // 两个技能共享同一批对照组数据，因此 B 组结果必须逐任务一致
  for (let i = 0; i < first.tasks.length; i += 1) {
    assert.deepEqual(
      { passed: first.tasks[i].control.passed, total: first.tasks[i].control.total },
      { passed: second.tasks[i].control.passed, total: second.tasks[i].control.total },
      `任务 ${first.tasks[i].taskId} 的对照组结果应跨技能一致`,
    );
  }
});

test('runEval：sort 后 lift 降序，装饰品/有害名单正确', async () => {
  const ts = loadTaskSet('codegen-basic');
  const good = fakeSkill('code-review', 'd', 'code-review diagnosing-bugs test-driven-development');
  const bad = fakeSkill('ppt', 'd', 'ppt slides');
  const result = await runEval([bad, good], ts, { repeat: 5, threshold: 10 });

  for (let i = 1; i < result.skills.length; i += 1) {
    assert.ok(result.skills[i - 1].lift >= result.skills[i].lift, 'lift 应降序排列');
  }
  // 有效技能不应出现在任何"需要处理"的名单里
  const flagged = [...result.decorativeSkills, ...result.harmfulSkills];
  assert.ok(flagged.includes('ppt'), `不相关技能应被标记，实际名单：${flagged.join(',') || '(空)'}`);
  assert.ok(!flagged.includes('code-review'), '有效技能不应被标记');
  // 名单与 verdict 必须一致
  for (const name of result.decorativeSkills) {
    assert.equal(result.skills.find((x) => x.skill === name).verdict, 'decorative');
  }
  for (const name of result.harmfulSkills) {
    assert.equal(result.skills.find((x) => x.skill === name).verdict, 'harmful');
  }
  // 统计口径自洽
  assert.equal(result.totals.decorativeCount, result.decorativeSkills.length);
  assert.equal(result.totals.harmfulCount, result.harmfulSkills.length);
  assert.equal(
    result.totals.decorativeCount + result.totals.harmfulCount + result.skills.filter((s) => s.verdict === 'useful').length,
    result.totals.skillCount,
  );
});

test('runEval：阈值可调，严格阈值会把弱提升也判为装饰品', async () => {
  const ts = loadTaskSet('codegen-basic');
  const skill = fakeSkill('code-review', '代码审查', 'code-review diagnosing-bugs');
  const loose = await runEval([skill], ts, { repeat: 5, threshold: 0 });
  const strict = await runEval([skill], ts, { repeat: 5, threshold: 101 });
  assert.ok(['useful', 'harmful'].includes(loose.skills[0].verdict) || loose.skills[0].lift === 0);
  assert.equal(strict.skills[0].verdict, 'decorative', '阈值为 101 时任何技能都不应判为有效');
});

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

test('buildEvalReport：产出自包含 HTML，含关键结论且无外部依赖', async () => {
  const ts = loadTaskSet('codegen-basic');
  const skill = fakeSkill('code-review', '代码审查', 'code-review diagnosing-bugs');
  const result = await runEval([skill], ts, { repeat: 2, threshold: 10 });
  const html = buildEvalReport(result, { version: '9.9.9', scope: 'test/fixtures' });

  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('</html>'));
  assert.ok(html.includes('code-review'), '应包含技能名');
  assert.ok(html.includes('A/B'), '应说明对照设计');
  assert.ok(html.includes('lift'), '应解释 lift 口径');
  // 自包含：不得引用外部资源
  assert.ok(!/<script\s+src=/i.test(html), '不应引用外部脚本');
  assert.ok(!/<link\b[^>]*stylesheet/i.test(html), '不应引用外部样式表');
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/i.test(html), '不应包含外部链接');
});

// ---------------------------------------------------------------------------
// CLI 集成
// ---------------------------------------------------------------------------

test('CLI：eval --json 输出可解析且结构正确', () => {
  const out = execFileSync(
    process.execPath,
    [CLI, 'eval', path.join(ROOT, 'test', 'fixtures'), '--no-defaults', '--repeat', '1', '--json'],
    { encoding: 'utf8' },
  );
  const r = JSON.parse(out);
  assert.equal(r.kind, 'skillops-eval');
  assert.equal(r.taskset.id, 'codegen-basic');
  assert.ok(Array.isArray(r.skills) && r.skills.length > 0);
  for (const s of r.skills) {
    assert.equal(typeof s.lift, 'number');
    assert.ok(['useful', 'decorative', 'harmful'].includes(s.verdict));
    assert.ok(s.tasks.length === r.taskset.taskCount);
  }
});

test('CLI：eval 文本输出含结论与口径说明', () => {
  const out = execFileSync(
    process.execPath,
    [CLI, 'eval', path.join(ROOT, 'test', 'fixtures'), '--no-defaults', '--repeat', '1'],
    { encoding: 'utf8' },
  );
  assert.ok(out.includes('A/B 对照实验'));
  assert.ok(out.includes('lift'));
  assert.ok(out.includes('唯一自变量'));
  assert.ok(out.includes('判定'), '应说明判定口径');
});

test('CLI：eval 可写出 HTML 报告文件', () => {
  const outFile = path.join(os.tmpdir(), `skillops-eval-${Date.now()}.html`);
  try {
    const out = execFileSync(
      process.execPath,
      [CLI, 'eval', path.join(ROOT, 'test', 'fixtures'), '--no-defaults', '--repeat', '1', '-o', outFile],
      { encoding: 'utf8' },
    );
    assert.ok(out.includes('HTML 报告已生成'));
    assert.ok(fs.existsSync(outFile));
    const html = fs.readFileSync(outFile, 'utf8');
    assert.ok(html.includes('lift'));
  } finally {
    try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
  }
});

test('CLI：eval 支持自定义任务集路径', () => {
  const tsPath = path.join(TASKS_DIR, 'codegen-basic.json');
  const out = execFileSync(
    process.execPath,
    [CLI, 'eval', path.join(ROOT, 'test', 'fixtures'), '--no-defaults', '--repeat', '1', '--tasks', tsPath, '--json'],
    { encoding: 'utf8' },
  );
  const r = JSON.parse(out);
  assert.equal(r.taskset.taskCount, 5);
});

test('CLI：可按名称选用 security-basic 任务集', () => {
  const out = execFileSync(
    process.execPath,
    [CLI, 'eval', path.join(ROOT, 'test', 'fixtures'), '--no-defaults', '--repeat', '1', '--tasks', 'security-basic', '--json'],
    { encoding: 'utf8' },
  );
  const r = JSON.parse(out);
  assert.equal(r.taskset.id, 'security-basic');
  assert.equal(r.taskset.taskCount, 5);
});

// ---------------------------------------------------------------------------
// 双向有效性：每个任务必须「打了补丁能过」且「不打补丁过不了」
// 缺任一半，任务就无法区分技能好坏（打不打都一样 → lift 必然为 0）
// ---------------------------------------------------------------------------

test('双向有效性：两个内置任务集的每个任务都能被判真伪', () => {
  // 这里只断言"判定器能在真实工作区上跑出结论"，端到端的双向验证由
  // scripts/check-taskset-two-way.mjs 负责（需要派生临时目录，成本较高）。
  for (const tsId of ['codegen-basic', 'security-basic']) {
    const ts = loadTaskSet(tsId);
    for (const task of ts.tasks) {
      const dir = tmpWith(task.workspace);
      try {
        // 初始工作区必须"跑得动"判定器（不崩溃、有明确结论），
        // 否则该任务无法参与 A/B 对比。
        const r = runVerifier(task.verify, dir, ts.verifyTimeoutMs);
        assert.equal(typeof r.passed, 'boolean', `${tsId}/${task.id} 判定结果应有 passed 布尔值`);
        assert.equal(typeof r.reason, 'string', `${tsId}/${task.id} 判定结果应有 reason 说明`);
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }
});

test('双向有效性：每个原始工作区都应判不通过（否则任务天然常绿，考点失效）', () => {
  for (const tsId of ['codegen-basic', 'security-basic']) {
    const ts = loadTaskSet(tsId);
    for (const task of ts.tasks) {
      const dir = tmpWith(task.workspace);
      try {
        const r = runVerifier(task.verify, dir, ts.verifyTimeoutMs);
        assert.equal(
          r.passed,
          false,
          `${tsId}/${task.id} 的初始工作区不应直接通过判定（reason: ${r.reason}）`,
        );
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }
});

test('CLI：对空目录运行 eval 会给出明确提示而非静默失败', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-empty-'));
  try {
    // 既有语义：扫描不到技能时 CLI 以非零码退出并提示（doctor/bench/eval 一致）。
    // 这里断言的是"提示清晰"，而不是"退出码为 0"——保持与其他命令行为一致。
    let out = '';
    let code = 0;
    try {
      out = execFileSync(
        process.execPath,
        [CLI, 'eval', emptyDir, '--no-defaults', '--repeat', '1'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (e) {
      code = e.status;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    assert.ok(out.includes('未发现任何技能'), `应提示未发现技能，实际输出：${out}`);
    assert.notEqual(code, 0, '扫描不到技能时应以非零码退出，与 doctor/bench 保持一致');
  } finally {
    try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
