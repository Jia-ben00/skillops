// 技能扫描：跨工具、跨层级发现技能目录
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkill } from './skillfile.js';
import { isSkillDir, listSubDirs, readJsonSafe } from './util.js';

/** 默认发现路径（按来源分组）；不存在/不可读的会被跳过 */
export function defaultSkillRoots(cwd, config = {}) {
  const home = os.homedir();
  const roots = [];
  const add = (dir, source) => {
    if (dir && fs.existsSync(dir)) roots.push({ dir, source });
  };
  for (const r of config.skillRoots || []) add(r, 'config');
  for (const r of (process.env.SKILLOPS_SKILLS || '').split(path.delimiter)) {
    if (r) add(r, 'env');
  }
  add(path.join(home, '.claude', 'skills'), 'claude-user');
  add(path.join(cwd, '.claude', 'skills'), 'claude-project');
  add(path.join(home, '.codex', 'skills'), 'codex-user');
  add(path.join(cwd, '.codex', 'skills'), 'codex-project');
  add(path.join(home, '.cursor', 'skills'), 'cursor-user');
  add(path.join(cwd, '.cursor', 'skills'), 'cursor-project');
  return roots;
}

/**
 * 扫描给定根目录集合，返回技能列表。
 * @param {Array<{dir:string,source:string}>} roots
 */
export function scan(roots) {
  const skills = [];
  for (const { dir, source } of roots) {
    for (const sub of listSubDirs(dir)) {
      if (!isSkillDir(sub)) continue;
      const skill = parseSkill(sub);
      skill.source = source;
      skills.push(skill);
    }
  }
  return skills;
}

/** 从 cwd / 配置 / 显式目录构造扫描结果（CLI 入口） */
export function scanFromArgs({ cwd = process.cwd(), config = {}, extraDirs = [], noDefaults = false } = {}) {
  const roots = noDefaults ? [] : defaultSkillRoots(cwd, config);
  for (const d of extraDirs) roots.push({ dir: d, source: 'explicit' });
  return { roots, skills: scan(roots) };
}

/** 读取用户配置 .skillopsrc.json */
export function loadConfig(cwd, configPath) {
  const p = configPath || path.join(cwd, '.skillopsrc.json');
  const cfg = readJsonSafe(p) || {};
  return {
    staleDays: cfg.staleDays ?? 180,
    budgets: {
      descChars: cfg.budgets?.descChars ?? 1536,
      skillLines: cfg.budgets?.skillLines ?? 500,
      listingTax: cfg.budgets?.listingTax ?? 380,
      triggerTax: cfg.budgets?.triggerTax ?? 4000,
      scorePass: cfg.budgets?.scorePass ?? 60,
    },
    skillRoots: cfg.skillRoots || [],
    ignore: cfg.ignore || [],
    configPath: p,
  };
}

/**
 * 智能扫描单个目录：目录本身是技能（含 SKILL.md）则直接解析；
 * 否则扫描其下的一级技能子目录。用于服务端/显式指定场景。
 */
export function scanSmartDir(dir, source = 'explicit') {
  if (isSkillDir(dir)) return [parseSkill(dir)];
  return listSubDirs(dir)
    .filter((sub) => isSkillDir(sub))
    .map((sub) => {
      const s = parseSkill(sub);
      s.source = source;
      return s;
    });
}
