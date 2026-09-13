// 治理执行：默认 dry-run，仅在显式 --apply 时落盘
// 动作：disable（重命名 *.disabled，可逆）/ update（git pull）/ 其余动作需人工处理
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './util.js';

const AUTO_ACTIONS = new Set(['disable', 'update']);
const APPLYABLE = new Set(['disable', 'update']);

/**
 * 生成治理计划（只读）
 * @param {object} analysis runAnalysis 输出
 * @param {{target?:string}} opts 只针对某技能
 */
export function plan(analysis, opts = {}) {
  return analysis.suggestions
    .filter((s) => APPLYABLE.has(s.action))
    .filter((s) => !opts.target || s.skill === opts.target);
}

/**
 * 执行计划
 * @param {Array} planItems
 * @param {{apply?:boolean}} opts apply=true 才真正修改
 * @returns {{changed:Array, skipped:Array}}
 */
export function execute(planItems, analysis, opts = {}) {
  const changed = [];
  const skipped = [];
  const dirOf = (name) => {
    const s = analysis.skills.find((x) => x.name === name);
    return s ? s.dir : null;
  };
  for (const item of planItems) {
    const dir = dirOf(item.skill);
    if (!dir) {
      skipped.push({ ...item, result: '找不到技能目录' });
      continue;
    }
    if (item.action === 'disable') {
      const target = `${dir}.disabled`;
      if (fs.existsSync(target)) {
        skipped.push({ ...item, result: '已存在 *.disabled，跳过' });
        continue;
      }
      if (!opts.apply) {
        changed.push({ ...item, result: `[dry-run] 将重命名 ${dir} → ${target}` });
        continue;
      }
      try {
        fs.renameSync(dir, target);
        changed.push({ ...item, result: `已停用：${target}` });
      } catch (e) {
        skipped.push({ ...item, result: `停用失败：${e.message}` });
      }
    } else if (item.action === 'update') {
      if (!opts.apply) {
        changed.push({ ...item, result: `[dry-run] 将在 ${dir} 执行 git pull` });
        continue;
      }
      const out = runGit(dir, ['pull', '--ff-only']);
      if (out == null) {
        skipped.push({ ...item, result: 'git pull 失败（非 git 仓库或网络问题）' });
      } else {
        changed.push({ ...item, result: `已更新：${out.split('\n')[0]}` });
      }
    }
  }
  return { changed, skipped };
}
