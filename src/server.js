// 团队版轻量服务端（MVP）：托管报告 + 一个体检 API
// 部署：docker compose up -d（见 docker/），或 node src/server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFromArgs, scanSmartDir, loadConfig } from './scanner.js';
import { runAnalysis } from './analyzers/index.js';
import { buildReport } from './report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const REPORT_DIR = path.resolve(process.env.SKILLOPS_REPORT_DIR || path.join(process.cwd(), 'reports'));
const DEFAULT_SKILLS_DIR = process.env.SKILLOPS_SKILLS_DIR || process.cwd();

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
  });
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SkillOps 团队控制台</title>
<style>
body{font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;margin:0;background:#f1f5f9;color:#0f172a;}
.wrap{max-width:760px;margin:0 auto;padding:32px 16px;}
h1{font-size:20px;} input{width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;box-sizing:border-box;}
button{margin-top:10px;padding:8px 18px;background:#0e7490;color:#fff;border:0;border-radius:8px;font-size:14px;cursor:pointer;}
pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;font-size:12px;overflow:auto;max-height:480px;}
a{color:#0e7490;}
</style></head>
<body><div class="wrap">
<h1>SkillOps 团队控制台（MVP）</h1>
<p style="font-size:13px;color:#475569;">对指定技能目录运行体检，查看 JSON 结果；或直接访问 <a href="/reports/">/reports/</a> 查看已生成报告。</p>
<input id="dir" placeholder="技能根目录（容器内路径，默认 ${esc(DEFAULT_SKILLS_DIR)}）" value="">
<button onclick="run()">运行体检</button>
<pre id="out">等待操作…</pre>
<script>
async function run(){
  const dir=document.getElementById('dir').value.trim()||'';
  const out=document.getElementById('out');
  out.textContent='体检中…';
  const r=await fetch('/api/doctor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({skillsRoot:dir})});
  const j=await r.json();
  out.textContent=JSON.stringify(j,null,2);
}
</script>
</div></body></html>`;

function esc(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (req.method === 'GET' && url.pathname === '/') {
      res.end(INDEX_HTML);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/doctor') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const root = body.skillsRoot || DEFAULT_SKILLS_DIR;
        const config = loadConfig(root);
        // 显式传入目录：直接扫描该目录下的技能；未传入：按默认位置探测
        const skills = body.skillsRoot
          ? scanSmartDir(root, 'server')
          : scanFromArgs({ cwd: root, config }).skills;
        const analysis = runAnalysis(skills, config);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(analysis, null, 2));
      } catch (e) {
        res.statusCode = 500;
        res.end(`<pre>${esc(e.stack || e.message)}</pre>`);
      }
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/reports/')) {
      const rel = decodeURIComponent(url.pathname.slice('/reports/'.length)).replace(/[\\/]/g, path.sep);
      const file = path.resolve(REPORT_DIR, rel);
      if (!file.startsWith(REPORT_DIR + path.sep) || !fs.existsSync(file)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      if (rel.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(file));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/reports' || req.method === 'GET' && url.pathname === '/reports/') {
      const files = fs.existsSync(REPORT_DIR) ? fs.readdirSync(REPORT_DIR).filter((f) => f.endsWith('.html')) : [];
      res.end(`<h1>已生成报告</h1><ul>${files.map((f) => `<li><a href="/reports/${encodeURIComponent(f)}">${esc(f)}</a></li>`).join('') || '<li>暂无</li>'}</ul>`);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
}

export function startServer() {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  createServer().listen(PORT, () => {
    console.log(`SkillOps 团队控制台已启动: http://localhost:${PORT}`);
    console.log(`报告目录: ${REPORT_DIR}`);
    console.log(`默认技能目录: ${DEFAULT_SKILLS_DIR}`);
  });
}
