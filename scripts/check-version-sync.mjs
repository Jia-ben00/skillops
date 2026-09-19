// 版本一致性校验（防漂移回归）。
//
// 项目里版本号的唯一来源是 package.json + src/version.js。
// 本脚本断言三件事，任一不满足即失败（退出码 1）：
//   1. install.sh  的默认版本 == package.json version
//   2. install.ps1 的默认版本 == package.json version
//   3. src/ 下不存在任何硬编码的 semver 字面量（版本必须经 src/version.js 读取）
//
// 第 3 条是关键：历史上版本同时散落在 install.sh / install.ps1 / cli.js / mcp.js /
// server.js / 报告模板兜底值 / console.html 七处，改一处会漏六处。
// 把「src 里不许出现版本字面量」变成断言，就不存在漏改的可能。
//
// 用法: node scripts/check-version-sync.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const pkg = JSON.parse(read('package.json'));
const want = pkg.version;
let fail = 0;
const bad = (msg) => {
  console.error(`::error:: ${msg}`);
  fail = 1;
};

// —— 1 & 2：安装脚本的默认版本 ——
const shMatch = read('install.sh').match(/VERSION="\$\{SKILLOPS_VERSION:-([^}]+)\}"/);
const shVer = shMatch ? shMatch[1] : null;
if (shVer !== want) bad(`install.sh 默认版本 ${shVer ?? '(未匹配到)'} != package.json ${want}`);

const ps1Match = read('install.ps1').match(/else\s*\{\s*'([^']+)'\s*\}/);
const ps1Ver = ps1Match ? ps1Match[1] : null;
if (ps1Ver !== want) bad(`install.ps1 默认版本 ${ps1Ver ?? '(未匹配到)'} != package.json ${want}`);

// —— 3：src/ 下不得出现硬编码版本 ——
const SEMVER = /\b\d+\.\d+\.\d+\b/;
const EXT = new Set(['.js', '.mjs', '.cjs', '.html']);
const offenders = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(abs);
    } else if (EXT.has(path.extname(e.name))) {
      const text = fs.readFileSync(abs, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (SEMVER.test(line)) {
          offenders.push(`${path.relative(ROOT, abs)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
  }
};
walk(path.join(ROOT, 'src'));
for (const o of offenders) bad(`src/ 内出现硬编码版本字面量（应改为从 src/version.js 读取）→ ${o}`);

if (fail) process.exit(1);
console.log(`版本一致: ${want} ✓  install.sh / install.ps1 默认版本已对齐，src/ 无硬编码版本字面量`);
