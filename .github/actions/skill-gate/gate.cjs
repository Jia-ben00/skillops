// SkillOps Skill Gate — 自包含版本门禁（不依赖仓库 src，供 GitHub Action 使用）
// 用法: node gate.js <skills-path> <registry-path> <strict:true|false>
// 退出码: 0=通过 1=存在 error 级不一致（未收录/未安装仅在 strict 时计 error）
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [, , skillsArg = 'skills', registryArg = '.skillops/registry.json', strictArg = 'true'] = process.argv;
const strict = strictArg !== 'false';

/** 技能目录判定：含 SKILL.md 或 *.mdc */
function isSkillDir(dir) {
  try {
    if (fs.statSync(path.join(dir, 'SKILL.md')).isFile()) return true;
  } catch {
    /* continue */
  }
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.mdc') && !f.startsWith('.'));
  } catch {
    return false;
  }
}

function listSubDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** 目录内容确定性校验和（rel+内容 的 sha256 前 12 位） */
function checksumSkill(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (d, base = '') => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) {
        hash.update(rel);
        hash.update('\0');
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

/** 解析 frontmatter（name/version/license） */
function parseSkill(dir) {
  let file = path.join(dir, 'SKILL.md');
  let format = 'agent-skill';
  if (!fs.existsSync(file)) {
    const mdc = fs.readdirSync(dir).find((f) => f.endsWith('.mdc'));
    if (!mdc) return null;
    file = path.join(dir, mdc);
    format = 'cursor-rule';
  }
  const raw = fs.readFileSync(file, 'utf8');
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (key === 'name' || key === 'version' || key === 'license') fm[key] = val;
    }
  }
  return {
    name: fm.name || path.basename(dir),
    version: fm.version || null,
    license: fm.license || null,
    format,
    dir,
  };
}

/** 语义化/数值版本比较 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v).match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/);
    if (!m) return null;
    return [m[1], m[2] || '0', m[3] || '0'].map(Number);
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a === b ? 'equal' : 'different';
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 'ahead' : 'stale';
  }
  return 'equal';
}

const root = process.env.GITHUB_WORKSPACE || process.cwd();
const skillsDir = path.resolve(root, skillsArg);
const registryPath = path.resolve(root, registryArg);

if (!fs.existsSync(registryPath)) {
  console.error(`::error::未找到 ${registryArg}，请先在仓库运行: node src/cli.js sync init . && node src/cli.js sync push . --apply`);
  process.exit(1);
}

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')).skills || {};
const localSkills = listSubDirs(skillsDir).map(parseSkill).filter(Boolean);
const results = [];

for (const s of localSkills) {
  const entry = registry[s.name];
  if (!entry) {
    results.push({ name: s.name, level: strict ? 'error' : 'info', msg: strict ? '未收录进团队仓库，请先 sync register' : '未收录进团队仓库' });
    continue;
  }
  let cmp;
  let label;
  if (s.version && entry.version) {
    cmp = compareVersions(s.version, entry.version);
    label = `v${s.version} / 团队 v${entry.version}`;
  } else if (!s.version && !entry.version) {
    const cs = checksumSkill(s.dir);
    cmp = cs === entry.checksum ? 'equal' : 'different';
    label = `checksum:${cs} / 团队 checksum:${entry.checksum}`;
  } else {
    cmp = 'different';
    label = `v${s.version || 'checksum'} / 团队 v${entry.version || 'checksum'}`;
  }
  if (cmp === 'equal') results.push({ name: s.name, level: 'ok', msg: `一致（${label}）` });
  else if (cmp === 'ahead') results.push({ name: s.name, level: 'info', msg: `领先团队仓库（${label}），建议 push` });
  else results.push({ name: s.name, level: 'error', msg: `版本落后于团队仓库（${label}）` });
}

for (const name of Object.keys(registry)) {
  if (!localSkills.some((s) => s.name === name)) {
    results.push({ name, level: strict ? 'error' : 'info', msg: strict ? '团队已收录但本地未安装' : '团队已收录但本地未安装' });
  }
}

let failed = false;
for (const r of results) {
  const mark = r.level === 'error' ? '✗' : r.level === 'ok' ? '✓' : 'i';
  console.log(`  ${mark} ${r.name}: ${r.msg}`);
  if (r.level === 'error') failed = true;
}
console.log(failed ? '\n门禁未通过 ✗' : '\n门禁通过 ✓');
process.exit(failed ? 1 : 0);
