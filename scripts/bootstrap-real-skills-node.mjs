// 真实技能自举（本机适配版）：用 codeload tarball + zlib 手工解包
//
// 为什么不用原版 scripts/bootstrap-real-skills.js：
//   原版依赖 `git clone`，在受限网络环境（代理拦截 git 智能协议）下会失败。
//   本脚本走 HTTPS 的 codeload tarball，并用 Node 内置 zlib 手工解 tar，
//   不依赖系统的 tar / git 命令，在 Windows + Git Bash PATH 受损时也能跑。
//
// 用法：node scripts/bootstrap-real-skills-node.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'examples', '.cache', 'real-skills');

/** 精选技能：名字 → 它在仓库中的 SKILL.md 路径片段 */
const SELECT = [
  { repo: 'mattpocock/skills', want: ['code-review', 'diagnosing-bugs'] },
  { repo: 'obra/superpowers', want: ['systematic-debugging', 'test-driven-development'] },
];

function fetchBuffer(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));
    https
      .get(url, { headers: { 'User-Agent': 'skillops-eval' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchBuffer(res.headers.location, depth + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

/** 极简 tar 解包（USTAR），只处理普通文件与目录 */
function untar(buf) {
  const files = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    // 全零块表示归档结束
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = String.fromCharCode(header[156]);
    off += 512;
    if (name && (type === '0' || type === '\0' || type === '')) {
      files.push({ name, data: buf.subarray(off, off + size) });
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

async function main() {
  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.mkdirSync(TARGET, { recursive: true });
  let installed = 0;

  for (const { repo, want } of SELECT) {
    const url = `https://codeload.github.com/${repo}/tar.gz/refs/heads/main`;
    let tgz;
    try {
      tgz = await fetchBuffer(url);
    } catch (e) {
      console.error(`  ✗ ${repo}: 下载失败 ${e.message}`);
      continue;
    }
    const files = untar(zlib.gunzipSync(tgz));
    // tarball 顶层是 <repo>-<branch>/，剥掉它
    const stripped = files.map((f) => ({ ...f, name: f.name.split('/').slice(1).join('/') }));

    for (const skillName of want) {
      const hit = stripped.find((f) => f.name === `skills/${skillName}/SKILL.md` || f.name.endsWith(`/${skillName}/SKILL.md`));
      if (!hit) {
        console.error(`  ✗ ${repo}: 未找到技能 ${skillName}`);
        continue;
      }
      const prefix = hit.name.slice(0, hit.name.length - 'SKILL.md'.length);
      const members = stripped.filter((f) => f.name.startsWith(prefix) && f.name !== prefix);
      const dest = path.join(TARGET, skillName);
      for (const m of members) {
        const rel = m.name.slice(prefix.length);
        if (!rel) continue;
        const p = path.join(dest, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, m.data);
      }
      const n = fs.readdirSync(dest, { recursive: true }).length;
      console.log(`  ✓ ${repo} → ${skillName}（${n} 个文件）`);
      installed += 1;
    }
  }
  console.log(`\n完成：${installed} 个真实技能 → ${TARGET}`);
  console.log('注：技能文件不提交仓库（尊重第三方 license），仅本地用于生成对照报告。');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
