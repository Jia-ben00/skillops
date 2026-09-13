// 真实技能自举：从公开 GitHub 仓库安装精选技能到 examples/.cache/real-skills
// 用途：复现 README 中的真实案例报告（技能文件本身不提交，仅报告与摘要进仓库）
// 用法：node scripts/bootstrap-real-skills.js
// 策略：优先 git clone --depth 1（一次拿全仓，无 API 限流）；git 不可用时回退 market API 下载
// 注意：公司代理/自签证书环境可能需要 NODE_TLS_REJECT_UNAUTHORIZED=0
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'examples', '.cache');
const TARGET = path.join(CACHE, 'real-skills');

// 精选：覆盖官方文档处理、方法论、工程实践三类
const SELECT = [
  { repo: 'anthropics/skills', skills: [0, 7, 11, 12, 13, 18] }, // academy-guide, docx, pdf, pptx, skill-creator, xlsx
  { repo: 'obra/superpowers', skills: [7, 8] }, // systematic-debugging, test-driven-development
  { repo: 'mattpocock/skills', skills: [1, 3] }, // code-review, diagnosing-bugs
];

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 用 git 浅克隆仓库（走系统证书/凭据，无 API 限流） */
function cloneRepo(repo, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  execFileSync('git', ['clone', '--depth', '1', `https://github.com/${repo}.git`, dest], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return dest;
}

/** 从已克隆仓库聚合技能目录（与 market.aggregateSkills 同口径） */
function listSkills(repoDir) {
  const out = execFileSync('git', ['-C', repoDir, 'ls-files'], { encoding: 'utf8' });
  const files = out.split('\n').filter(Boolean);
  const byDir = new Map();
  for (const f of files) {
    const isSkill = /(^|\/)SKILL\.md$/i.test(f) || /(^|\/)[^/]+\.mdc$/i.test(f);
    if (!isSkill) continue;
    const dir = f.split('/').slice(0, -1).join('/');
    const base = f.split('/').pop();
    const key = dir || `__root__${base}`;
    if (!byDir.has(key)) {
      byDir.set(key, { name: dir.split('/').pop() || base.replace(/\.(md|mdc)$/i, ''), root: dir });
    }
  }
  return [...byDir.values()];
}

async function installViaMarket(repo, skillIndex, dest) {
  const { discoverSkills, downloadSkill } = await import('../src/market.js');
  const d = await discoverSkills(globalThis.fetch, repo, { max: 60 });
  const skill = d.skills[skillIndex];
  if (!skill) throw new Error(`技能序号 ${skillIndex} 不存在`);
  const files = await downloadSkill(globalThis.fetch, d, skillIndex);
  for (const f of files.files) {
    const rel = f.relPath.replace(`${skill.root}${skill.root ? '/' : ''}`, '');
    const p = path.join(dest, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
  }
  return files.files.length;
}

async function main() {
  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.mkdirSync(TARGET, { recursive: true });
  const useGit = gitAvailable();
  console.log(useGit ? '使用 git clone（推荐，无 API 限流）' : 'git 不可用，回退 market API 下载（有速率限制）');

  let installed = 0;
  for (const { repo, skills: indexes } of SELECT) {
    let repoDir = null;
    if (useGit) {
      repoDir = path.join(CACHE, 'repos', repo.split('/')[1]);
      try {
        cloneRepo(repo, repoDir);
      } catch (e) {
        console.error(`  ! git clone ${repo} 失败（${e.message.split('\n')[0]}），回退 market API`);
        repoDir = null;
      }
    }
    const all = repoDir ? listSkills(repoDir) : null;
    for (const idx of indexes) {
      const dest = path.join(TARGET, all ? all[idx].name : `skill-${idx}`);
      try {
        if (all && all[idx]) {
          const src = path.join(repoDir, all[idx].root);
          fs.cpSync(src, dest, { recursive: true });
          const n = fs.readdirSync(dest, { recursive: true }).length;
          console.log(`  ✓ ${repo} → ${all[idx].name}（${n} 个文件）`);
        } else {
          const n = await installViaMarket(repo, idx, dest);
          console.log(`  ✓ ${repo} → ${path.basename(dest)}（${n} 个文件，market API）`);
        }
        installed += 1;
      } catch (e) {
        console.error(`  ✗ ${repo} → 序号 ${idx}: ${e.message.split('\n')[0]}`);
      }
    }
  }
  console.log(`\n完成：${installed} 个真实技能 → ${TARGET}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
