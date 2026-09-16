// Agent 后端适配器
//
// 设计目标：mock 后端与真实 CLI 后端实现**同一个接口**，runEval 只依赖接口，
// 不依赖具体后端。这样从一个后端换到另一个只需改一个字符串参数。
//
// 接口契约：
//   run({ prompt, cwd, skillContext, timeoutMs }) → {
//     exitCode: number|null,
//     stdout: string,
//     stderr: string,
//     durationMs: number,
//     timedOut: boolean,
//     backend: string,
//     // 可选：Agent 自报的改动（真实后端可能无法精确提供，允许为空数组）
//     changedFiles: string[],
//   }
//
// 关键语义：`skillContext` 是**技能注入的唯一通道**。
//   - A 组（treatment）：skillContext 非空 → 后端应把技能内容加入模型上下文
//   - B 组（control）：  skillContext 为 null → 后端不得看到任何技能内容
// 这个区别必须在后端内部实现，且必须可被测试断言（见 test/eval.test.js）。
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * 把技能内容拼成一段可注入的上下文块。
 * 真实后端通常把它塞进系统提示或临时文件；mock 后端用它做行为决策。
 */
export function buildSkillContext(skill) {
  if (!skill) return null;
  return [
    `# 已加载技能：${skill.name}`,
    skill.description ? `> ${skill.description}` : '',
    '',
    skill.body || '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * mock 后端：确定性、零成本、可在 CI 里跑。
 *
 * 它不调用任何模型，而是用「技能是否命中任务标签」来决定行为：
 *   - 注入的技能名/描述命中任务的 skillTags → 视为「技能起了作用」→ 尝试完成任务
 *   - 没有技能，或技能未命中 → 视为「靠自身能力」→ 只完成它能力范围内的部分
 *
 * 为了模拟真实世界的噪声，每个 (任务, 是否加载技能) 组合用确定性哈希决定成败，
 * 而不是「命中就一定成功」。这样跑出来的 lift 是**分布**而不是 0/100 的假数。
 */
function deterministicRoll(seed) {
  // FNV-1a 32 位，纯函数、跨平台一致
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 1000) / 1000; // 0.000 ~ 0.999
}

function mockBackend() {
  return {
    name: 'mock',
    async run({ prompt, skillContext, task, applySolution, arm, attempt }) {
      const started = Date.now();
      // 种子必须包含三样东西，缺一不可：
      //   1. task.id — 不同任务难度不同
      //   2. arm     — 否则 A/B 两组拿到同一个随机数，lift 恒等于 0
      //   3. attempt — 否则 repeat 次重复得到完全相同的结果，均值毫无意义
      const roll = deterministicRoll(`${task.id}::${arm}::${attempt ?? 0}`);

      // 技能命中检测：技能名或其描述关键词是否出现在任务声明的 skillTags 里
      const tags = (task.skillTags || []).map((t) => t.toLowerCase());
      const ctxLower = (skillContext || '').toLowerCase();
      const skillHit = Boolean(skillContext) && tags.some((t) => ctxLower.includes(t));

      // 基础能力：即使没有技能，模型也能做对一部分（模拟真实强模型）
      // 有技能且命中时成功率显著更高；没命中则几乎无增益（这正是"装饰品"技能的特征）
      let successProb;
      if (skillHit) {
        successProb = 0.85;
      } else if (skillContext) {
        successProb = 0.35; // 加载了一个不相关的技能：有干扰，低于裸跑
      } else {
        successProb = 0.5;
      }

      const succeeded = roll < successProb;

      // 成功时：真正把工作区改成"正确答案"（让 verify 能真通过）
      // 失败时：保持原样（让 verify 真的失败）
      const changedFiles = [];
      if (succeeded && applySolution) {
        applySolution();
        changedFiles.push(...Object.keys(task.solution || {}));
      }

      return {
        exitCode: succeeded ? 0 : 1,
        stdout: succeeded ? `[mock] 任务 ${task.id} 已处理` : `[mock] 任务 ${task.id} 未完成`,
        stderr: succeeded ? '' : '[mock] 未能满足全部约束',
        durationMs: Date.now() - started,
        timedOut: false,
        backend: 'mock',
        changedFiles,
        skillHit,
        _promptSeenByAgent: prompt, // 供测试断言注入通道
        _skillSeenByAgent: skillContext,
      };
    },
  };
}

/**
 * 真实 CLI 后端：把 prompt（含技能上下文）交给外部 Agent 命令。
 * 例：--agent "claude -p" / --agent "codex exec"
 *
 * 注意：真实 Agent 是否真的"读到"了技能，取决于它自身是否支持从此处注入。
 * 因此真实后端默认采用**显式注入**：技能内容直接拼进 prompt 文本。
 * 这是最保守、可复现的做法——不依赖 Agent 的隐式 skill 目录发现。
 */
function cliBackend(cmdline) {
  const parts = cmdline.split(/\s+/).filter(Boolean);
  const [cmd, ...baseArgs] = parts;
  return {
    name: `cli:${cmdline}`,
    async run({ prompt, cwd, skillContext, timeoutMs }) {
      const started = Date.now();
      const fullPrompt = skillContext ? `${skillContext}\n\n---\n\n${prompt}` : prompt;
      let r;
      try {
        r = spawnSync(cmd, [...baseArgs, fullPrompt], {
          cwd,
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
          shell: process.platform === 'win32', // Windows 下需要 shell 才能解析 .cmd/.bat
        });
      } catch (e) {
        return {
          exitCode: null,
          stdout: '',
          stderr: `spawn failed: ${e.message}`,
          durationMs: Date.now() - started,
          timedOut: false,
          backend: `cli:${cmdline}`,
          changedFiles: [],
        };
      }
      const timedOut = r.error?.code === 'ETIMEDOUT';
      return {
        exitCode: r.status,
        stdout: r.stdout || '',
        stderr: r.stderr || (r.error ? String(r.error.message || r.error) : ''),
        durationMs: Date.now() - started,
        timedOut,
        backend: `cli:${cmdline}`,
        changedFiles: [],
        _promptSeenByAgent: fullPrompt,
        _skillSeenByAgent: skillContext,
      };
    },
  };
}

/**
 * 解析后端选择。
 * @param {string} agent "mock"（默认）或外部命令字符串
 */
export function resolveBackend(agent) {
  if (!agent || agent === 'mock') return mockBackend();
  return cliBackend(agent);
}

/** 报告用的后端说明 */
export function describeBackend(backend) {
  if (backend.name === 'mock') {
    return 'mock（确定性模拟后端，零模型调用，可在 CI 中复现）';
  }
  return `真实 Agent CLI：${backend.name}`;
}

export { deterministicRoll, path };
