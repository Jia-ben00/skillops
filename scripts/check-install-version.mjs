// 校验 install.sh / install.ps1 的默认版本与 package.json 一致。
// 防止「改了 package.json 版本，但安装脚本还硬编码旧版本」的漂移回归。
// 用法: node scripts/check-install-version.mjs   （不一致时退出码 1）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const want = pkg.version;

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// install.sh: VERSION="${SKILLOPS_VERSION:-0.6.0}"
const sh = read('install.sh');
const shMatch = sh.match(/VERSION="\$\{SKILLOPS_VERSION:-([^}]+)\}"/);
const shVer = shMatch ? shMatch[1] : null;

// install.ps1: ... else { '0.6.0' }
const ps1 = read('install.ps1');
const ps1Match = ps1.match(/else\s*\{\s*'([^']+)'\s*\}/);
const ps1Ver = ps1Match ? ps1Match[1] : null;

let fail = 0;
const check = (label, got) => {
  if (got !== want) {
    console.error(`::error:: ${label} 默认版本 ${got ?? '(未匹配到)'} != package.json ${want}`);
    fail = 1;
  }
};
check('install.sh', shVer);
check('install.ps1', ps1Ver);

if (fail) process.exit(1);
console.log(`install 脚本版本一致: ${want} ✓`);
