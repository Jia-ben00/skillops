// 技能市场：从公开 GitHub 仓库扫描发现技能、安装、订阅更新
// 零依赖：仅用 Node 18+ 内置 fetch + 标准库；支持 GITHUB_TOKEN 提升速率限制
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const subscriptionsFile = () => path.join(os.homedir(), '.skillops', 'subscriptions.json');

function apiHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'skillops' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

/** 统一请求：返回 JSON；HTTP 错误抛带状态的消息 */
export async function ghFetch(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: apiHeaders() });
  if (!res.ok) {
    if (res.status === 429 || res.status === 403) {
      throw new Error('GitHub API 速率限制（未认证约 10 次/分）。可设置 GITHUB_TOKEN 提升额度，或稍后重试。');
    }
    if (res.status === 404) throw new Error(`未找到资源: ${url}`);
    throw new Error(`GitHub API ${res.status}: ${url}`);
  }
  return res.json();
}

/** 解析仓库参数：支持 owner/repo 或完整 URL */
export function parseRepoArg(arg) {
  const m = String(arg).match(/github\.com\/([^/]+)\/([^/]+?)(?:\/|$)/);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
  const parts = String(arg).split('/').filter(Boolean);
  if (parts.length === 2) return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
  throw new Error(`仓库参数格式应为 owner/repo 或完整 URL，实际: ${arg}`);
}

/** 搜索公开仓库（GitHub repo search API，免认证可用，10 次/分） */
export async function searchRepos(fetchImpl, query, { limit = 10 } = {}) {
  const q = encodeURIComponent(query || 'skills in:name,description');
  const data = await ghFetch(fetchImpl, `${API}/search/repositories?q=${q}&sort=stars&order=desc&per_page=${limit}`);
  return (data.items || []).map((r) => ({
    fullName: r.full_name,
    description: (r.description || '').slice(0, 120),
    stars: r.stargazers_count,
    defaultBranch: r.default_branch || 'main',
    htmlUrl: r.html_url,
  }));
}

const SKILL_FILE_RE = /(^|\/)(SKILL\.md|[^/]+\.mdc)$/i;

/** 从仓库 git tree 中聚合出技能条目：技能根目录 = SKILL.md/.mdc 所在目录，files 含目录下全部文件 */
export function aggregateSkills(tree, { max = 20 } = {}) {
  const blobs = (tree.tree || []).filter((e) => e.type === 'blob');
  const entries = blobs.filter((e) => SKILL_FILE_RE.test(e.path));
  const byDir = new Map();
  for (const f of entries) {
    const dir = path.posix.dirname(f.path);
    const name = path.posix.basename(f.path);
    const key = dir === '.' ? `__root__${name}` : dir;
    if (!byDir.has(key)) {
      byDir.set(key, {
        name: dir === '.' ? name.replace(/\.(md|mdc)$/i, '') : dir.split('/').pop(),
        root: dir === '.' ? '' : dir,
        format: /\.mdc$/i.test(name) ? 'cursor-rule' : 'agent-skill',
        files: [],
      });
    }
  }
  for (const skill of byDir.values()) {
    if (skill.root === '') {
      // 仓库根级技能：只收顶层文件，避免把整个仓库当技能下载
      skill.files = blobs.filter((b) => path.posix.dirname(b.path) === '.').map((b) => b.path);
    } else {
      skill.files = blobs.filter((b) => b.path.startsWith(`${skill.root}/`)).map((b) => b.path);
    }
  }
  return [...byDir.values()].slice(0, max);
}

/** 探测仓库中的技能（git trees API，一次调用拿全树） */
export async function discoverSkills(fetchImpl, repo, { max = 20 } = {}) {
  const { owner, repo: name } = parseRepoArg(repo);
  const meta = await ghFetch(fetchImpl, `${API}/repos/${owner}/${name}`);
  const branch = meta.default_branch || 'main';
  const tree = await ghFetch(fetchImpl, `${API}/repos/${owner}/${name}/git/trees/${branch}?recursive=1`);
  const skills = aggregateSkills(tree, { max });
  return { owner, repo: name, branch, skills };
}

/** 单个文件 sha256 前 12 位（与 checksumSkill 同口径） */
export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/** 下载单个文件：优先 raw（不限流），失败（代理/5xx/网络）自动回退 contents API（base64） */
async function downloadFile(fetchImpl, rawUrl, apiUrl) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchImpl(rawUrl, { headers: { 'User-Agent': 'skillops' } });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status < 500 && res.status !== 429) break; // 4xx 不重试，直接回退
    } catch {
      /* 网络错误 → 回退 */
    }
  }
  const data = await ghFetch(fetchImpl, apiUrl);
  if (!data.content) throw new Error(`contents API 未返回内容: ${apiUrl}`);
  return Buffer.from(data.content, data.encoding || 'base64');
}

/** 下载技能目录全部文件（raw 优先，contents API 兜底） */
export async function downloadSkill(fetchImpl, { owner, repo, branch, skills: entries }, skillIndex, { onProgress } = {}) {
  const skill = entries[skillIndex];
  if (!skill) throw new Error(`技能序号不存在: ${skillIndex}`);
  const files = [];
  for (const relPath of skill.files) {
    const enc = relPath.split('/').map(encodeURIComponent).join('/');
    const rawUrl = `${RAW}/${owner}/${repo}/${branch}/${enc}`;
    const apiUrl = `${API}/repos/${owner}/${repo}/contents/${enc}`;
    const content = await downloadFile(fetchImpl, rawUrl, apiUrl);
    files.push({ relPath, content, checksum: sha256(content) });
    if (onProgress) onProgress(relPath);
  }
  return { ...skill, files };
}

/** 读取订阅文件 */
export function loadSubscriptions() {
  try {
    const data = JSON.parse(fs.readFileSync(subscriptionsFile(), 'utf8'));
    return Array.isArray(data.subscriptions) ? data.subscriptions : [];
  } catch {
    return [];
  }
}

export function saveSubscriptions(list) {
  const file = subscriptionsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ subscriptions: list }, null, 2) + '\n', 'utf8');
}

/** 新增订阅（按 repo+skillName 去重） */
export function subscribe(fetchImpl, repoArg, { skillIndex = 0, target = null } = {}) {
  const list = loadSubscriptions();
  const existing = list.find((s) => s.repo === repoArg && s.skillIndex === skillIndex);
  const entry = {
    repo: repoArg,
    skillIndex,
    target: target || path.join(os.homedir(), '.claude', 'skills'),
    lastUpdate: null,
    addedAt: new Date().toISOString(),
  };
  if (existing) {
    Object.assign(existing, entry);
    saveSubscriptions(list);
    return { entry: existing, added: false };
  }
  list.push(entry);
  saveSubscriptions(list);
  return { entry, added: true };
}

/** 更新单个订阅：比对本地校验和，差异文件写盘（默认 dry-run） */
export async function updateSubscription(fetchImpl, sub, { apply = false } = {}) {
  const { owner, repo: name } = parseRepoArg(sub.repo);
  const meta = await ghFetch(fetchImpl, `${API}/repos/${owner}/${name}`);
  const branch = meta.default_branch || 'main';
  const tree = await ghFetch(fetchImpl, `${API}/repos/${owner}/${name}/git/trees/${branch}?recursive=1`);
  const entries = aggregateSkills(tree);
  const skill = entries[sub.skillIndex];
  if (!skill) return { ...sub, status: 'error', message: `仓库 ${sub.repo} 的序号 ${sub.skillIndex} 技能不存在` };
  const targetDir = path.join(sub.target, skill.name);
  const downloaded = await downloadSkill(fetchImpl, { owner, repo: name, branch, skills: entries }, sub.skillIndex);

  const changed = [];
  for (const f of downloaded.files) {
    const dest = path.join(targetDir, f.relPath.replace(`${skill.root}${skill.root ? '/' : ''}`, ''));
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    if (existing && sha256(existing) === f.checksum) continue;
    changed.push({ relPath: f.relPath, dest, action: existing ? '更新' : '新增' });
    if (apply) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.content);
    }
  }
  const result = { ...sub, skill: skill.name, branch, changed, applied: apply };
  if (apply) {
    result.lastUpdate = new Date().toISOString();
    const list = loadSubscriptions();
    const idx = list.findIndex((s) => s.repo === sub.repo && s.skillIndex === sub.skillIndex);
    if (idx >= 0) {
      list[idx].lastUpdate = result.lastUpdate;
      saveSubscriptions(list);
    }
  }
  return result;
}

/** 更新全部订阅 */
export async function updateAll(fetchImpl, { apply = false } = {}) {
  const list = loadSubscriptions();
  const results = [];
  for (const sub of list) {
    try {
      results.push(await updateSubscription(fetchImpl, sub, { apply }));
    } catch (e) {
      results.push({ ...sub, status: 'error', message: e.message });
    }
  }
  return results;
}
