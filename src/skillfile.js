// 技能文件解析：多格式统一模型
// 支持：
//  - agent-skill：Agent Skills / Anthropic 风格（目录内 SKILL.md，YAML frontmatter）
//  - cursor-rule：Cursor Rules（目录内 *.mdc，YAML frontmatter：description/globs/alwaysApply）
// 输出统一的技能模型，供扫描/体检/评测/报告复用。
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './util.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 解析一行 frontmatter：`key: value`（支持引号） */
function parseLine(line) {
  const idx = line.indexOf(':');
  if (idx <= 0) return null;
  const key = line.slice(0, idx).trim().toLowerCase();
  let val = line.slice(idx + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return [key, val];
}

export function parseFrontmatter(raw) {
  const fmMatch = raw.match(FRONTMATTER_RE);
  const frontmatter = {};
  let body = raw;
  if (fmMatch) {
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const kv = parseLine(line);
      if (kv) frontmatter[kv[0]] = kv[1];
    }
    body = raw.slice(fmMatch[0].length);
  }
  return { frontmatter, body };
}

/** 从代码块中提取脚本语言与正文 */
function extractCodeFences(content) {
  const fences = [];
  const re = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    fences.push({ lang: m[1] || 'text', code: m[2] });
  }
  return fences;
}

/** 列出目录下全部文件（忽略隐藏，限深） */
function listFiles(dir, maxDepth = 4) {
  const files = [];
  const walk = (dirPath, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dirPath, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        files.push({ path: full, rel: path.relative(dir, full), size });
      }
    }
  };
  walk(dir, 0);
  return files;
}

function finalize(dir, raw, frontmatter, body, format, toolHint) {
  const fences = extractCodeFences(raw);
  const inlineScriptTokens = fences
    .filter((f) => !['text', 'markdown', 'md', 'json', 'yaml', 'yml', 'toml', 'sh-session'].includes(f.lang))
    .reduce((acc, f) => acc + estimateTokens(f.code), 0);
  const description = frontmatter.description || '';
  const name = frontmatter.name || path.basename(dir);
  return {
    dir,
    format,
    toolHint,
    name,
    frontmatter,
    description,
    hasDescription: description.trim().length > 0,
    lines: raw.split(/\r?\n/).length,
    sizeBytes: Buffer.byteLength(raw, 'utf8'),
    body,
    codeFences: fences,
    inlineScriptTokens,
    files: listFiles(dir),
    hasLicense: Boolean(frontmatter.license),
    hasVersion: Boolean(frontmatter.version),
    license: frontmatter.license || null,
    version: frontmatter.version || null,
    allowedTools: frontmatter['allowed-tools'] || frontmatter.allowed_tools || null,
    // 常驻税：名称 + 描述每轮都会进上下文
    listingTax: estimateTokens(`${name} ${description}`),
    // 触发税：正文在被调用时才加载（渐进式披露口径）
    triggerTax: estimateTokens(body),
  };
}

/** 解析 Agent Skills（SKILL.md） */
export function parseSkillMd(dir, skillFile) {
  let raw = '';
  try {
    raw = fs.readFileSync(skillFile, 'utf8');
  } catch (e) {
    return { dir, name: path.basename(dir), error: e.message };
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  return finalize(dir, raw, frontmatter, body, 'agent-skill', 'claude');
}

/** 解析 Cursor Rules（*.mdc） */
export function parseCursorRule(dir, mdcFile) {
  let raw = '';
  try {
    raw = fs.readFileSync(mdcFile, 'utf8');
  } catch (e) {
    return { dir, name: path.basename(mdcFile), error: e.message };
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  const base = path.basename(mdcFile, '.mdc');
  return {
    ...finalize(dir, raw, frontmatter, body, 'cursor-rule', 'cursor'),
    name: frontmatter.name || base,
    file: mdcFile,
    globs: frontmatter.globs || null,
    alwaysApply: frontmatter.alwaysapply || frontmatter.alwaysApply || null,
  };
}

/**
 * 按目录自动探测并解析技能（多格式统一入口）。
 * @param {string} dir 技能目录
 */
export function parseSkill(dir) {
  const skillFile = path.join(dir, 'SKILL.md');
  if (fs.existsSync(skillFile)) return parseSkillMd(dir, skillFile);
  const mdcs = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.mdc') && !f.startsWith('.'))
    : [];
  if (mdcs.length) return parseCursorRule(dir, path.join(dir, mdcs[0]));
  return { dir, name: path.basename(dir), error: '未检测到 SKILL.md 或 *.mdc' };
}
