// 构建 GitHub Release 资产：skillops-cli-<version>.tgz + sha256 + release.json
// 用法: node scripts/build-release.js [version]   （默认取 package.json 的 version）
// 产物: dist/skillops-cli-<version>.tgz, dist/...tgz.sha256, dist/release.json
// 之后可将三个文件 attach 到 GitHub Release（gh release create v<version> dist/*）
// 零依赖零外部命令：手写 ustar 归档 + 标准库 zlib，任何有 Node 的环境（含无 npm/tar）都可构建
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = process.argv[2] || pkg.version;
const dist = path.join(ROOT, 'dist');

/** 极简 ustar tar 打包：entries = [{path, type:'file'|'dir', content?}] → Buffer */
function toTar(entries) {
  const blocks = [];
  const pad = (buf, size) => {
    const out = Buffer.alloc(size);
    buf.copy(out);
    return out;
  };
  const header = (name, size, type) => {
    const h = Buffer.alloc(512);
    const nameBuf = Buffer.from(name, 'utf8');
    nameBuf.copy(h, 0, 0, Math.min(nameBuf.length, 100));
    const write = (off, len, val) => h.write(val, off, len); // 八进制 ascii 字符串，默认 utf8 写
    write(100, 8, '0000644'); // mode
    write(108, 8, '0000000'); // uid
    write(116, 8, '0000000'); // gid
    write(124, 12, size.toString(8).padStart(11, '0') + '\0');
    write(136, 12, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0');
    h.write('        ', 148, 8, 'ascii'); // checksum 占位
    h.write(type, 156, 1, 'ascii'); // typeflag: '0' file, '5' dir
    h.write('ustar\0', 257, 6, 'ascii'); // magic
    h.write('00', 263, 2, 'ascii'); // version
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return h;
  };
  for (const e of entries) {
    if (e.type === 'dir') {
      blocks.push(header(e.path.endsWith('/') ? e.path : e.path + '/', 0, '5'));
    } else {
      const content = Buffer.from(e.content, 'utf8');
      blocks.push(header(e.path, content.length, '0'));
      blocks.push(pad(content, Math.ceil(content.length / 512) * 512));
    }
  }
  blocks.push(Buffer.alloc(512), Buffer.alloc(512)); // 结尾空块
  return Buffer.concat(blocks);
}

// 1) 按 package.json files 白名单收集文件（与 npm pack 同口径）
const entries = [];
const collect = (dir, prefix) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(abs, rel);
    } else if (entry.isFile()) {
      entries.push({ path: `package/${rel.split(path.sep).join('/')}`, type: 'file', content: fs.readFileSync(abs, 'utf8') });
    }
  }
};
for (const f of pkg.files) {
  const abs = path.join(ROOT, f);
  if (fs.statSync(abs).isDirectory()) collect(abs, f);
  else entries.push({ path: `package/${f}`, type: 'file', content: fs.readFileSync(abs, 'utf8') });
}
entries.push({ path: 'package/package.json', type: 'file', content: JSON.stringify(pkg, null, 2) + '\n' });

/** CRC32（zip 头必需，Node 标准库无 crc32，手写查表） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 极简 zip（store 不压缩）：entries → Buffer，PowerShell/.NET 原生可解压 */
function toZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const data = Buffer.from(e.content, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header 签名
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    lh.writeUInt16LE(0, 8); // method: store
    lh.writeUInt16LE(0, 10); // time
    lh.writeUInt16LE(0, 12); // date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central directory 签名
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
    ch.writeUInt16LE(0, 10); // method: store
    ch.writeUInt16LE(0, 12); // mod time
    ch.writeUInt16LE(0, 14); // mod date
    ch.writeUInt32LE(crc, 16); // crc32
    ch.writeUInt32LE(data.length, 20); // compressed size
    ch.writeUInt32LE(data.length, 24); // uncompressed size
    ch.writeUInt16LE(name.length, 28); // filename length
    ch.writeUInt16LE(0, 30); // extra length
    ch.writeUInt16LE(0, 32); // comment length
    ch.writeUInt16LE(0, 34); // disk number start
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42); // local header offset
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

// 2) 产出 tgz（Unix）+ zip（Windows）
const tgzName = `skillops-cli-${version}.tgz`;
const zipName = `skillops-cli-${version}.zip`;
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, tgzName), zlib.gzipSync(toTar(entries)));
fs.writeFileSync(path.join(dist, zipName), toZip(entries));

// 3) sha256 + 清单
const shaOf = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex');
const sha256 = shaOf(tgzName);
for (const f of [tgzName, zipName]) fs.writeFileSync(path.join(dist, `${f}.sha256`), `${shaOf(f)}  ${f}\n`);

const release = {
  package: tgzName,
  zip: zipName,
  version,
  sha256,
  assets: [tgzName, `${tgzName}.sha256`, zipName, `${zipName}.sha256`, 'release.json'],
  install: {
    windows: 'irm https://raw.githubusercontent.com/Jia-ben00/skillops/main/install.ps1 | iex',
    unix: 'curl -fsSL https://raw.githubusercontent.com/Jia-ben00/skillops/main/install.sh | sh',
    npm: `npm i -g skillops-cli@${version}`,
  },
};
fs.writeFileSync(path.join(dist, 'release.json'), JSON.stringify(release, null, 2) + '\n');

console.log(`\nRelease assets ready in ${dist}:`);
console.log(`  ${tgzName} (${(fs.statSync(path.join(dist, tgzName)).size / 1024).toFixed(1)} kB, ${entries.length} files)`);
console.log(`  ${zipName} (${(fs.statSync(path.join(dist, zipName)).size / 1024).toFixed(1)} kB)`);
console.log(`  sha256 files + release.json`);
console.log(`\nAttach to GitHub:\n  gh release create v${version} ${dist}/* --title "SkillOps v${version}" --notes "..."`);
