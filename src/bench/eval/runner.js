// runEval：A/B 对照实验执行器
//
// 这是整个 eval 的核心。它回答的问题只有一句话：
//   **把这份技能注入 Agent 之后，任务成功率提升了多少？**
//
// 方法是唯一能支持这个结论的方法：对照实验。
//   A 组（treatment）：注入 SKILL.md 内容
//   B 组（control）：  不注入任何技能内容
//   其余一切相同（同一任务、同一后端、同一初始工作区、同一随机种子）
//
// 因此唯一自变量是「有没有技能」，因变量是「verify 是否通过」。
// 单组跑没有任何归因能力——这正是原先 `--agent` 实验模式的根本缺陷。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSkillContext, resolveBackend } from './agent.js';

/** 在工作区写入初始文件（含 solution 覆盖，供 mock 后端使用） */
function materialize(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

function makeTmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `skillops-eval-${tag}-`));
}

/** 递归删除临时目录；Windows 下 fs.rmSync 偶发 EBUSY，做一次重试 */
function cleanup(dir, keep) {
  if (keep) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 60 });
  } catch {
    /* 临时目录残留不影响结论 */
  }
}

/**
 * 运行客观判定器。
 * @returns {{passed:boolean, exitCode:number|null, stdout:string, stderr:string, reason:string}}
 */
export function runVerifier(verify, cwd, timeoutMs) {
  let r;
  try {
    r = spawnSync(verify.cmd, verify.args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(verify.cmd),
    });
  } catch (e) {
    return { passed: false, exitCode: null, stdout: '', stderr: e.message, reason: `无法执行判定命令：${e.message}` };
  }
  if (r.error?.code === 'ETIMEDOUT') {
    return {
      passed: false,
      exitCode: null,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      reason: `判定命令超时（>${timeoutMs}ms）`,
    };
  }
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const expectExit = verify.expectExit ?? 0;

  if (r.status !== expectExit) {
    return {
      passed: false,
      exitCode: r.status,
      stdout,
      stderr,
      reason: `退出码 ${r.status} ≠ 期望 ${expectExit}`,
    };
  }
  if (verify.mustContain && !stdout.includes(verify.mustContain)) {
    return {
      passed: false,
      exitCode: r.status,
      stdout,
      stderr,
      reason: `输出未包含必需片段 "${verify.mustContain}"`,
    };
  }
  if (verify.mustNotContain && stdout.includes(verify.mustNotContain)) {
    return {
      passed: false,
      exitCode: r.status,
      stdout,
      stderr,
      reason: `输出包含了禁止片段 "${verify.mustNotContain}"`,
    };
  }
  return { passed: true, exitCode: r.status, stdout, stderr, reason: '通过' };
}

/** 跑单次（一个任务 × 一个分组 × 一次尝试） */
async function runOnce({ task, taskset, backend, skill, arm, attempt, keepWorkdir }) {
  const dir = makeTmpDir(arm);
  try {
    materialize(dir, task.workspace);
    const skillContext = arm === 'treatment' ? buildSkillContext(skill) : null;
    const agentResult = await backend.run({
      prompt: task.prompt,
      cwd: dir,
      skillContext,
      timeoutMs: taskset.verifyTimeoutMs,
      task,
      arm,
      attempt,
      // mock 后端在"判定成功"时用 solution 真正改写工作区，
      // 保证 verify 的通过/失败是真实发生的文件状态，而不是凭空断言的布尔值。
      applySolution: () => materialize(dir, task.solution || {}),
    });
    const verdict = runVerifier(task.verify, dir, taskset.verifyTimeoutMs);
    return {
      arm,
      attempt,
      passed: verdict.passed,
      reason: verdict.reason,
      exitCode: agentResult.exitCode,
      durationMs: agentResult.durationMs,
      timedOut: Boolean(agentResult.timedOut),
      backend: agentResult.backend,
      skillHit: agentResult.skillHit ?? null,
      // 保留极少量诊断信息，便于发现"注入通道断了"这类问题
      injectedChars: skillContext ? skillContext.length : 0,
    };
  } finally {
    cleanup(dir, keepWorkdir);
  }
}

/**
 * 执行 A/B 对照实验。
 *
 * @param {Array} skills     被测技能（parseSkill 输出）
 * @param {object} taskset   loadTaskSet 输出
 * @param {object} opts
 *   - agent: string          后端选择，默认 "mock"
 *   - repeat: number         每个条件的重复次数，默认 1（提高可降噪但成本线性增长）
 *   - threshold: number      |lift| 低于此值判为装饰品（百分点），默认 10
 *   - keepWorkdir: boolean   保留临时工作区用于排查
 *   - onProgress: Function   进度回调
 */
export async function runEval(skills, taskset, opts = {}) {
  const repeat = Math.max(1, Number(opts.repeat) || 1);
  const threshold = Number.isFinite(opts.threshold) ? Number(opts.threshold) : 10;
  const backend = resolveBackend(opts.agent);
  const onProgress = opts.onProgress || (() => {});

  const usableSkills = skills.filter((s) => !s.error);
  const perSkill = [];
  /** 每个任务在 control 组的结果会被多个技能复用（对照组的定义就是这样） */
  const controlCache = new Map();

  for (let si = 0; si < usableSkills.length; si += 1) {
    const skill = usableSkills[si];
    const taskResults = [];
    let treatPass = 0;
    let ctrlPass = 0;
    let total = 0;

    for (const task of taskset.tasks) {
      // ---- B 组：对照组，不注入技能。对每个任务只需算一次，跨技能共享。----
      if (!controlCache.has(task.id)) {
        const runs = [];
        for (let k = 0; k < repeat; k += 1) {
          runs.push(await runOnce({ task, taskset, backend, skill: null, arm: 'control', attempt: k, keepWorkdir: opts.keepWorkdir }));
        }
        const passedCount = runs.filter((r) => r.passed).length;
        controlCache.set(task.id, {
          passed: passedCount,
          total: runs.length,
          rate: passedCount / runs.length,
          runs,
        });
      }
      const ctrl = controlCache.get(task.id);

      // ---- A 组：实验组，注入该技能 ----
      const treatRuns = [];
      for (let k = 0; k < repeat; k += 1) {
        treatRuns.push(await runOnce({ task, taskset, backend, skill, arm: 'treatment', attempt: k, keepWorkdir: opts.keepWorkdir }));
      }
      const treatPassed = treatRuns.filter((r) => r.passed).length;

      treatPass += treatPassed;
      ctrlPass += ctrl.passed;
      total += treatRuns.length;

      taskResults.push({
        taskId: task.id,
        title: task.title,
        skillTags: task.skillTags,
        treatment: { passed: treatPassed, total: treatRuns.length, rate: treatPassed / treatRuns.length },
        control: { passed: ctrl.passed, total: ctrl.total, rate: ctrl.rate },
        lift: Math.round(((treatPassed / treatRuns.length) - ctrl.rate) * 100),
        skillHit: treatRuns.some((r) => r.skillHit === true),
        reasons: treatRuns.filter((r) => !r.passed).map((r) => r.reason).slice(0, 3),
      });
    }

    const treatRate = total ? treatPass / total : 0;
    const ctrlRate = total ? ctrlPass / total : 0;
    const lift = Math.round((treatRate - ctrlRate) * 100);

    perSkill.push({
      skill: skill.name,
      dir: skill.dir,
      format: skill.format,
      listingTax: skill.listingTax,
      triggerTax: skill.triggerTax,
      treatment: { passed: treatPass, total, rate: Number(treatRate.toFixed(3)) },
      control: { passed: ctrlPass, total, rate: Number(ctrlRate.toFixed(3)) },
      lift,
      verdict: classify(lift, threshold),
      tasks: taskResults,
    });

    onProgress({ done: si + 1, total: usableSkills.length, skill: skill.name });
  }

  // lift 降序：最有用的排最前，装饰品沉底
  perSkill.sort((a, b) => b.lift - a.lift || a.skill.localeCompare(b.skill));

  const decorative = perSkill.filter((p) => p.verdict === 'decorative');
  const harmful = perSkill.filter((p) => p.verdict === 'harmful');

  return {
    kind: 'skillops-eval',
    generatedAt: new Date().toISOString(),
    backend: backend.name,
    taskset: { id: taskset.id, name: taskset.name, taskCount: taskset.tasks.length },
    config: { repeat, threshold },
    totals: {
      skillCount: perSkill.length,
      decorativeCount: decorative.length,
      harmfulCount: harmful.length,
      avgLift: perSkill.length ? Math.round(perSkill.reduce((a, p) => a + p.lift, 0) / perSkill.length) : 0,
    },
    skills: perSkill,
    decorativeSkills: decorative.map((p) => p.skill),
    harmfulSkills: harmful.map((p) => p.skill),
  };
}

/** 判定分类：升/降/无差别 */
function classify(lift, threshold) {
  if (lift <= -threshold) return 'harmful';
  if (lift < threshold) return 'decorative';
  return 'useful';
}

export const VERDICT_LABEL = {
  useful: '有效',
  decorative: '装饰品',
  harmful: '有害',
};

/** 供 CLI/报告复用的人类可读判定说明 */
export function verdictExplanation(lift, threshold) {
  if (lift <= -threshold) {
    return `注入后成功率反而下降 ${Math.abs(lift)} 个百分点（≥ 阈值 ${threshold}），该技能在拖后腿`;
  }
  if (lift < threshold) {
    return `注入前后成功率差 ${lift} 个百分点，低于阈值 ${threshold}，未能证明有效`;
  }
  return `注入后成功率提升 ${lift} 个百分点（≥ 阈值 ${threshold}）`;
}
