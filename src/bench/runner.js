// SkillBench 运行器：对每个技能运行套件检查，可选接入 Agent 实测
import { spawnSync } from 'node:child_process';
import { estimateTokens, isGitRepo } from '../util.js';

const GRADE = (s) => (s >= 90 ? 'A' : s >= 75 ? 'B' : s >= 60 ? 'C' : 'D');

const CHECK_IMPLS = {
  frontmatter_valid(skill) {
    return Boolean(skill.frontmatter && skill.frontmatter.name);
  },
  has_description(skill) {
    return skill.hasDescription;
  },
  desc_informative(skill, param = {}) {
    return skill.description.trim().length >= (param.minChars ?? 40);
  },
  desc_within_limit(skill, param = {}) {
    return skill.description.length <= (param.maxChars ?? 1536);
  },
  lines_within_limit(skill, param = {}) {
    return skill.lines <= (param.maxLines ?? 500);
  },
  no_inline_big_scripts(skill, param = {}) {
    return skill.inlineScriptTokens <= (param.maxTokens ?? 3000);
  },
  license_or_source(skill) {
    const hasManifest = skill.files.some((f) => /(^|\\)(package\.json|pyproject\.toml|requirements\.txt)$/i.test(f.rel));
    return skill.hasLicense || skill.hasVersion || isGitRepo(skill.dir) || hasManifest;
  },
};

/** 运行 Agent 实测（实验性）：用外部编码 Agent CLI 让模型读技能并回答固定问题 */
function runAgentProbe(agentCmd, skill, taskTemplate) {
  if (!agentCmd) return null;
  const parts = agentCmd.split(/\s+/).filter(Boolean);
  const [cmd, ...args] = parts;
  const prompt = (taskTemplate || '请阅读 {dir}/SKILL.md，用不超过 3 句话说明：1) 它最适合什么任务；2) 潜在风险或与其他技能的冲突。').replaceAll('{dir}', skill.dir);
  const started = Date.now();
  let r;
  try {
    r = spawnSync(cmd, [...args, prompt], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  } catch {
    return { error: 'spawn failed' };
  }
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return {
    exitCode: r.status,
    durationMs: Date.now() - started,
    outputChars: out.length,
    estTokens: estimateTokens(out),
    tail: out.slice(-400),
  };
}

/**
 * @param {Array} skills parseSkill 输出
 * @param {object} suite
 * @param {{agent?: string, taskTemplate?: string}} opts
 */
export function runSuite(skills, suite, opts = {}) {
  const totalWeight = suite.checks.reduce((a, c) => a + (c.weight || 0), 0) || 1;
  const results = skills.map((skill) => {
    let passed = 0;
    const checks = suite.checks.map((c) => {
      const impl = CHECK_IMPLS[c.id];
      const pass = impl ? Boolean(impl(skill, c.param || {})) : false;
      if (pass) passed += c.weight || 0;
      return { id: c.id, name: c.name, pass };
    });
    const score = Math.round((passed / totalWeight) * 100);
    const agent = runAgentProbe(opts.agent, skill, opts.taskTemplate);
    return {
      skill: skill.name,
      dir: skill.dir,
      score,
      grade: GRADE(score),
      checks,
      agent,
    };
  });
  const avg = results.length ? Math.round(results.reduce((a, r) => a + r.score, 0) / results.length) : 100;
  return {
    suite: { id: suite.id, name: suite.name, description: suite.description },
    generatedAt: new Date().toISOString(),
    avgScore: avg,
    avgGrade: GRADE(avg),
    results,
  };
}
