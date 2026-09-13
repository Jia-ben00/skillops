// SkillOps Web 工作台：报告可视化 + 治理操作界面（零依赖 http 服务器）
// API:
//   GET  /                控制台 SPA
//   GET  /api/health      健康检查（版本 + 默认目录）
//   GET  /api/skills?dir= 技能列表（轻量）
//   POST /api/doctor      完整体检（body: {skillsRoot}）
//   POST /api/fix/plan    治理计划（只读 dry-run 预览，body: {skillsRoot, target}）
//   POST /api/fix/apply   执行治理（body: {skillsRoot, items:[{action,skill}]}）
//   GET  /api/report?dir= 生成报告到 REPORT_DIR 并返回路径
//   GET  /reports/*       托管已生成报告
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFromArgs, scanSmartDir, loadConfig } from './scanner.js';
import { runAnalysis } from './analyzers/index.js';
import { buildReport } from './report.js';
import { plan as planFix, execute as executeFix } from './fix.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.5.0';
const REPORT_DIR = path.resolve(process.env.SKILLOPS_REPORT_DIR || path.join(process.cwd(), 'reports'));
// 端口与默认技能目录：CLI 可在运行时通过 setter 覆盖（模块加载时的 env 为兜底）
let port = Number(process.env.PORT || 3000);
export function setPort(p) {
  if (p) port = Number(p);
}
let defaultSkillsDir = process.env.SKILLOPS_SKILLS_DIR || process.cwd();
export function setSkillsDir(dir) {
  if (dir) defaultSkillsDir = dir;
}
const CONSOLE_HTML = fs.readFileSync(path.join(__dirname, 'web', 'console.html'), 'utf8');

function json(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data, null, 2));
}
function html(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(data);
}

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

function analysisFor(root) {
  const config = loadConfig(root);
  const skills = root
    ? scanSmartDir(root, 'server')
    : scanFromArgs({ cwd: defaultSkillsDir, config }).skills;
  return runAnalysis(skills, config);
}

/** 治理执行：只接受自动动作，且技能必须在本次体检结果内（防路径注入） */
async function handleFixApply(body) {
  const root = body.skillsRoot || defaultSkillsDir;
  const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
  const analysis = analysisFor(root);
  const valid = new Set(analysis.skills.map((s) => s.name));
  const filtered = items.filter(
    (it) => it && valid.has(it.skill) && (it.action === 'disable' || it.action === 'update'),
  );
  const { changed, skipped } = executeFix(filtered, analysis, { apply: true });
  return { changed, skipped, appliedCount: changed.length, analysis: { score: analysis.score, grade: analysis.grade } };
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        html(res, CONSOLE_HTML);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        json(res, { ok: true, version: VERSION, skillsDir: defaultSkillsDir, reportDir: REPORT_DIR });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/skills') {
        const root = url.searchParams.get('dir') || defaultSkillsDir;
        const a = analysisFor(root);
        json(res, {
          score: a.score,
          grade: a.grade,
          skills: a.skills.map((s) => ({
            name: s.name,
            format: s.format,
            source: s.source,
            score: s.score,
            grade: s.grade,
            listingTax: s.listingTax,
            triggerTax: s.triggerTax,
            lines: s.lines,
            issueCount: s.issueCount,
          })),
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/doctor') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const root = body.skillsRoot || defaultSkillsDir;
        const a = analysisFor(root);
        json(res, { skillsRoot: root, ...a });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/fix/plan') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const root = body.skillsRoot || defaultSkillsDir;
        const a = analysisFor(root);
        const items = planFix(a, { target: body.target || undefined });
        json(res, {
          score: a.score,
          grade: a.grade,
          plan: items.map((it) => ({ action: it.action, skill: it.skill, reason: it.reason, detail: it.detail, result: `[dry-run] ${it.action} ${it.skill}` })),
          suggestions: a.suggestions,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/fix/apply') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = await handleFixApply(body);
        json(res, result);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/report') {
        const root = url.searchParams.get('dir') || defaultSkillsDir;
        const a = analysisFor(root);
        if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
        const name = `skillops-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.html`;
        const outPath = path.join(REPORT_DIR, name);
        fs.writeFileSync(outPath, buildReport(a, { scope: root, version: VERSION }), 'utf8');
        json(res, { path: outPath, name, bytes: fs.statSync(outPath).size, score: a.score, grade: a.grade });
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/reports/')) {
        const rel = decodeURIComponent(url.pathname.slice('/reports/'.length)).replace(/[\\/]/g, path.sep);
        const file = path.resolve(REPORT_DIR, rel);
        if (!file.startsWith(REPORT_DIR + path.sep) || !fs.existsSync(file)) {
          html(res, 'not found', 404);
          return;
        }
        if (rel.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(fs.readFileSync(file));
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/reports' || url.pathname === '/reports/')) {
        const files = fs.existsSync(REPORT_DIR) ? fs.readdirSync(REPORT_DIR).filter((f) => f.endsWith('.html')) : [];
        html(res, `<h1>已生成报告</h1><ul>${files.map((f) => `<li><a href="/reports/${encodeURIComponent(f)}">${f}</a></li>`).join('') || '<li>暂无</li>'}</ul>`);
        return;
      }
      html(res, 'not found', 404);
    } catch (e) {
      json(res, { message: e.message, stack: e.stack }, 500);
    }
  });
}

export function startServer() {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  createServer().listen(port, () => {
    console.log(`SkillOps Web 工作台已启动: http://localhost:${port}`);
    console.log(`报告目录: ${REPORT_DIR}`);
    console.log(`默认技能目录: ${defaultSkillsDir}`);
  });
}
