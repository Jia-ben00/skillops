// 基础工具：token 估算、文本相似度、git 助手、路径工具
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 统计文本中的 CJK 字符数（每个 CJK 字符按 1 token 估算） */
export function countCjk(text) {
  const m = String(text || '').match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g);
  return m ? m.length : 0;
}

/**
 * 粗略估算 token 数（明确标注为估算口径）：
 * CJK 字符 1 字符 ≈ 1 token；其余字符 4 字符 ≈ 1 token。
 */
export function estimateTokens(text) {
  const s = String(text || '');
  const cjk = countCjk(s);
  const other = s.length - cjk;
  return cjk + Math.ceil(other / 4);
}

/** 字符串按 2-gram 切分（用于相似度） */
export function bigrams(s) {
  const norm = String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const out = new Set();
  for (let i = 0; i < norm.length - 1; i += 1) {
    out.add(norm.slice(i, i + 2));
  }
  return out;
}

/** Jaccard 相似度（0~1） */
export function jaccard(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 组合相似度：描述相似度为主，名称相似度加权 */
export function similarity(aName, aDesc, bName, bDesc) {
  const d = jaccard(aDesc, bDesc);
  const n = jaccard(aName, bName);
  return d * 0.7 + n * 0.3;
}

/** 同步执行 git 命令；失败返回 null（不抛异常） */
export function runGit(dir, args) {
  try {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (r.status !== 0) return null;
    return (r.stdout || '').trim();
  } catch {
    return null;
  }
}

/** 目录是否为 git 仓库 */
export function isGitRepo(dir) {
  return runGit(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/** 文件/目录最后修改时间（ms）；不存在返回 null */
export function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** 目录是否包含 SKILL.md（技能目录判定） */
export function isSkillDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}

/** 列出目录下的一级子目录（跳过隐藏与 .disabled） */
export function listSubDirs(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.endsWith('.disabled'))
    .map((e) => path.join(root, e.name));
}

/** 递归收集目录下全部文件（相对路径），限制深度，忽略隐藏目录 */
export function listFilesRecursive(root, maxDepth = 3) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/** 读取 JSON 配置，失败返回 null */
export function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 人类可读的时间差 */
export function humanAge(ms) {
  if (ms == null) return '未知';
  const days = Math.floor(ms / 86400000);
  if (days >= 365) return `${Math.floor(days / 365)} 年前`;
  if (days >= 30) return `${Math.floor(days / 30)} 个月前`;
  return `${days} 天前`;
}
