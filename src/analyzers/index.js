// 分析编排：汇总全部体检项、计算评分与治理建议
import { analyzeContext } from './context.js';
import { analyzeConflicts } from './conflicts.js';
import { analyzeSecurity } from './security.js';

const SEVERITY_PENALTY = { error: 15, warn: 8, info: 3 };
const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

function gradeOf(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}

/** 对单个技能运行单技能体检 */
export function analyzeSkill(skill, config) {
  return [...analyzeContext(skill, config.budgets), ...analyzeSecurity(skill)];
}

/**
 * 全量体检
 * @param {Array} skills
 * @param {{budgets:object, staleDays:number}} config
 */
export function runAnalysis(skills, config) {
  const issues = [];
  for (const s of skills) {
    s.issues = analyzeSkill(s, config);
    issues.push(...s.issues);
  }
  const { issues: pairIssues, pairs } = analyzeConflicts(skills, config);
  issues.push(...pairIssues);

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // 每个技能的问题总数（含技能间问题）
  const issueCounts = {};
  for (const issue of issues) {
    issueCounts[issue.skill] = (issueCounts[issue.skill] || 0) + 1;
  }

  // 评分
  const perSkill = new Map(skills.map((s) => [s.name, { ...s, score: 100 }]));
  for (const issue of issues) {
    const target = perSkill.get(issue.skill);
    if (target) target.score = Math.max(0, target.score - SEVERITY_PENALTY[issue.severity]);
  }
  const scored = [...perSkill.values()].map((s) => ({
    name: s.name,
    dir: s.dir,
    source: s.source,
    score: s.score,
    grade: gradeOf(s.score),
    listingTax: s.listingTax,
    triggerTax: s.triggerTax,
    lines: s.lines,
    ageDays: s.ageDays,
    issueCount: issueCounts[s.name] || 0,
  }));

  const totals = {
    skillCount: skills.length,
    listingTax: skills.reduce((a, s) => a + s.listingTax, 0),
    triggerTax: skills.reduce((a, s) => a + s.triggerTax, 0),
    sizeBytes: skills.reduce((a, s) => a + s.sizeBytes, 0),
    bySeverity: {
      error: issues.filter((i) => i.severity === 'error').length,
      warn: issues.filter((i) => i.severity === 'warn').length,
      info: issues.filter((i) => i.severity === 'info').length,
    },
  };

  // 全局分 = 100 - 按技能平均扣分
  const avg = scored.length ? scored.reduce((a, s) => a + s.score, 0) / scored.length : 100;
  const globalScore = Math.round(avg);
  const suggestions = buildSuggestions(scored, issues, pairs, config);

  return {
    generatedAt: new Date().toISOString(),
    totals,
    score: globalScore,
    grade: gradeOf(globalScore),
    skills: scored,
    issues,
    pairs,
    suggestions,
  };
}

function buildSuggestions(scored, issues, pairs, config) {
  const out = [];
  const bySkill = new Map();
  for (const s of scored) bySkill.set(s.name, s);
  const find = (id, skill) => issues.find((i) => i.id === id && i.skill === skill);

  for (const s of scored) {
    if (s.score < 50) {
      out.push({ action: 'disable', skill: s.name, reason: `综合分仅 ${s.score}（${s.grade}），建议停用或重写`, detail: `问题 ${s.issueCount} 项` });
    } else if (find('CONTEXT_DESC_OVER', s.name) || find('CONTEXT_TRIGGER_TAX', s.name) || find('CONTEXT_LINES_OVER', s.name)) {
      out.push({ action: 'slim', skill: s.name, reason: '上下文税偏高，建议精简描述 / 拆分 supporting files', detail: '渐进式披露：SKILL.md 只放触发与路由' });
    }
    if (find('STALE', s.name)) {
      out.push({ action: 'update', skill: s.name, reason: `已 ${s.ageDays} 天未更新`, detail: '若为 git 仓库可用 skillops fix --apply --skill <name> 更新' });
    }
    if (find('RISKY_PIPE_SHELL', s.name) || find('RISKY_RM_RF', s.name) || find('RISKY_EXFIL', s.name)) {
      out.push({ action: 'review', skill: s.name, reason: '脚本含高危启发式命中，需人工复核', detail: '技能会获得真实执行权限，务必确认命令来源' });
    }
  }
  const dupNames = new Set(pairs.filter((p) => p.type === 'duplicate').map((p) => p.a));
  for (const n of dupNames) {
    out.push({ action: 'merge', skill: n, reason: '存在高度重复技能，建议合并或二选一', detail: '重复技能会同时烧常驻税并造成触发歧义' });
  }
  const overlapNames = new Set(pairs.filter((p) => p.type === 'workflow-conflict').map((p) => p.a));
  for (const n of overlapNames) {
    out.push({ action: 'split', skill: n, reason: '与另一技能存在工作流冲突（只读 vs 写入）', detail: '明确触发边界或拆分职责' });
  }
  return out;
}
