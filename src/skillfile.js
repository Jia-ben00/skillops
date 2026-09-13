// SKILL.md 解析：frontmatter 提取 + 文件画像
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './util.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * 解析一行 frontmatter：`key: value`（支持引号）
 * @returns {[string, string] | null}
 */
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

/** 从代码块中提取脚本语言与正文，返回 [{lang, code}] */
function extractCodeFences(content) {
  const fences = [];
  const re = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    fences.push({ lang: m[1] || 'text', code: m[2] });
  }
  return fences;
}

/**
 * 解析一个技能目录：
 * @param {string} dir 技能目录（含 SKILL.md）
 */
export function parseSkill(dir) {
  const skillFile = path.join(dir, 'SKILL.md');
  let raw = '';
  try {
    raw = fs.readFileSync(skillFile, 'utf8');
  } catch (e) {
    return { dir, name: path.basename(dir), error: e.message };
  }

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

  const fences = extractCodeFences(raw);
  const inlineScriptTokens = fences
    .filter((f) => !['text', 'markdown', 'md', 'json', 'yaml', 'yml', 'toml', 'sh-session'].includes(f.lang))
    .reduce((acc, f) => acc + estimateTokens(f.code), 0);

  const files = [];
  const walk = (dirPath, depth) => {
    if (depth > 4) return;
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

  const description = frontmatter.description || '';

  return {
    dir,
    name: frontmatter.name || path.basename(dir),
    frontmatter,
    description,
    hasDescription: description.trim().length > 0,
    lines: raw.split(/\r?\n/).length,
    sizeBytes: Buffer.byteLength(raw, 'utf8'),
    body,
    codeFences: fences,
    inlineScriptTokens,
    files,
    hasLicense: Boolean(frontmatter.license),
    hasVersion: Boolean(frontmatter.version),
    license: frontmatter.license || null,
    version: frontmatter.version || null,
    allowedTools: frontmatter['allowed-tools'] || null,
    // 常驻税：名称 + 描述每轮都会进上下文
    listingTax: estimateTokens(`${frontmatter.name || ''} ${description}`),
    // 触发税：SKILL.md 主体在被调用时才加载（渐进式披露口径）
    triggerTax: estimateTokens(body),
  };
}
