// 团队策略：以 Git 仓库为单一事实源的技能同步与版本门禁
// 团队仓库布局：
//   <teamRepo>/skills/<skill-name>/{SKILL.md | *.mdc}
//   <teamRepo>/.skillops/registry.json   # 版本门禁的唯一权威
//   <teamRepo>/.skillopsignore
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSkill, parseFrontmatter } from './skillfile.js';
import { isSkillDir, listSubDirs, readJsonSafe } from './util.js';

const REGISTRY_PATH = (repo) => path.join(repo, '.skillops', 'registry.json');
const SKILLS_DIR = (repo) => path.join(repo, 'skills');

/** 计算技能目录的确定性校验和（所有文件 rel+内容 的 sha256 前 12 位） */
export function checksumSkill(dir) {
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

/** 技能版本：优先 frontmatter version，否则用校验和兜底 */
export function versionOf(skill) {
  if (skill.version) return skill.version;
  const s = parseSkill(skill.dir);
  if (s.version) return s.version;
  return `checksum:${checksumSkill(skill.dir)}`;
}

/** 语义化/数值版本比较；无法比较时退化为字符串 */
export function compareVersions(a, b) {
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

function emptyRegistry() {
  return { version: 1, updatedAt: null, skills: {} };
}

function readRegistry(repo) {
  return readJsonSafe(REGISTRY_PATH(repo)) || emptyRegistry();
}

/** 从团队仓库 skills/ 重建 registry */
export function buildRegistry(repo) {
  const reg = emptyRegistry();
  const skillsDir = SKILLS_DIR(repo);
  if (fs.existsSync(skillsDir)) {
    for (const sub of listSubDirs(skillsDir)) {
      if (!isSkillDir(sub)) continue;
      const skill = parseSkill(sub);
      if (skill.error) continue;
      reg.skills[skill.name] = {
        version: skill.version || null,
        license: skill.license || null,
        format: skill.format,
        toolHint: skill.toolHint,
        updatedAt: new Date().toISOString(),
        checksum: checksumSkill(sub),
      };
    }
  }
  reg.updatedAt = new Date().toISOString();
  return reg;
}

/** 初始化团队仓库布局 */
export function initTeamRepo(repo) {
  const out = [];
  for (const d of [repo, SKILLS_DIR(repo), path.join(repo, '.skillops')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const regPath = REGISTRY_PATH(repo);
  if (!fs.existsSync(regPath)) {
    fs.writeFileSync(regPath, JSON.stringify(emptyRegistry(), null, 2) + '\n', 'utf8');
    out.push(regPath);
  }
  const ignorePath = path.join(repo, '.skillopsignore');
  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(ignorePath, '# 忽略无需进入团队仓库的技能\n', 'utf8');
    out.push(ignorePath);
  }
  return out;
}

/** 把本地技能目录拷贝进团队仓库 skills/ 并重建 registry（默认 dry-run） */
export function pushSkills(repo, localDir, { apply = false } = {}) {
  const plan = [];
  for (const sub of listSubDirs(localDir)) {
    if (!isSkillDir(sub)) continue;
    const skill = parseSkill(sub);
    if (skill.error) continue;
    plan.push({ name: skill.name, from: sub, to: path.join(SKILLS_DIR(repo), skill.name) });
  }
  const changed = [];
  if (apply) {
    fs.mkdirSync(SKILLS_DIR(repo), { recursive: true });
    for (const p of plan) {
      fs.rmSync(p.to, { recursive: true, force: true });
      fs.cpSync(p.from, p.to, { recursive: true });
    }
    const reg = buildRegistry(repo);
    fs.writeFileSync(REGISTRY_PATH(repo), JSON.stringify(reg, null, 2) + '\n', 'utf8');
  }
  for (const p of plan) {
    changed.push({ ...p, result: apply ? `已推送 ${p.name}` : `[dry-run] 将推送 ${p.name}` });
  }
  return { changed, registryWritten: apply };
}

/** 版本门禁：把本地技能与团队 registry 比对 */
export function gateSkills(repo, localDir) {
  const reg = readRegistry(repo);
  const results = [];
  const localSkills = listSubDirs(localDir)
    .filter((sub) => isSkillDir(sub))
    .map((sub) => parseSkill(sub))
    .filter((s) => !s.error);

  for (const s of localSkills) {
    const entry = reg.skills[s.name];
    if (!entry) {
      results.push({ name: s.name, status: 'unregistered', level: 'info', message: '本地技能未收录进团队仓库' });
      continue;
    }
    // 版本比较：双方都有 frontmatter version 时语义比较；都没有时用校验和比对
    let cmp;
    let label;
    if (s.version && entry.version) {
      cmp = compareVersions(s.version, entry.version);
      label = `v${s.version} / 团队 v${entry.version}`;
    } else if (!s.version && !entry.version) {
      const localChecksum = checksumSkill(s.dir);
      cmp = localChecksum === entry.checksum ? 'equal' : 'different';
      label = `checksum:${localChecksum} / 团队 checksum:${entry.checksum}`;
    } else {
      cmp = 'different';
      label = `v${s.version || 'checksum'} / 团队 v${entry.version || 'checksum'}`;
    }
    if (cmp === 'equal') {
      results.push({ name: s.name, status: 'ok', level: 'ok', message: `与团队仓库一致（${label}）` });
    } else if (cmp === 'ahead') {
      results.push({ name: s.name, status: 'ahead', level: 'info', message: `本地版本领先团队仓库（${label}），建议 push` });
    } else {
      results.push({ name: s.name, status: 'stale', level: 'error', message: `版本落后于团队仓库（${label}），门禁未通过` });
    }
  }
  for (const [name, entry] of Object.entries(reg.skills)) {
    if (!localSkills.some((s) => s.name === name)) {
      results.push({ name, status: 'missing_local', level: 'info', message: `团队已收录但本地未安装（v${entry.version || 'checksum'}）` });
    }
  }
  const hasBlock = results.some((r) => r.level === 'error');
  return { results, passed: !hasBlock, registryPath: REGISTRY_PATH(repo) };
}

/** 把团队仓库技能拉取到本地目录（默认 dry-run） */
export function pullSkills(repo, localDir, { apply = false } = {}) {
  const changed = [];
  const reg = readRegistry(repo);
  const skillsDir = SKILLS_DIR(repo);
  if (!fs.existsSync(skillsDir)) return { changed, registryWritten: false };
  for (const sub of listSubDirs(skillsDir)) {
    if (!isSkillDir(sub)) continue;
    const skill = parseSkill(sub);
    if (skill.error) continue;
    const target = path.join(localDir, skill.name);
    changed.push({
      name: skill.name,
      result: apply ? `已拉取 ${skill.name}（v${reg.skills[skill.name]?.version || 'checksum'}）` : `[dry-run] 将拉取 ${skill.name}`,
      target,
    });
    if (apply) {
      fs.mkdirSync(localDir, { recursive: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(sub, target, { recursive: true });
    }
  }
  return { changed, registryWritten: false };
}
