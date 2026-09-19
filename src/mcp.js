// 最小 MCP 服务器（零依赖）：让任意 MCP 客户端（Claude Desktop / Cursor 等）调用 SkillOps
// 协议：JSON-RPC 2.0 over stdio（换行分隔 JSON，兼容 Content-Length 帧）
// 工具：skillops_doctor / skillops_bench / skillops_report
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { scanSmartDir, loadConfig } from './scanner.js';
import { runAnalysis } from './analyzers/index.js';
import { loadSuite } from './bench/suite.js';
import { runSuite } from './bench/runner.js';
import { buildReport } from './report.js';
import { VERSION } from './version.js';

const NAME = 'skillops';

const TOOLS = [
  {
    name: 'skillops_doctor',
    description: '对指定技能目录运行 SkillOps 体检（上下文税/触发重叠/工作流冲突/重复/过期/安全），返回 JSON 分析结果',
    inputSchema: {
      type: 'object',
      properties: {
        skillsRoot: { type: 'string', description: '技能根目录（目录本身或含技能子目录），默认当前目录' },
      },
    },
  },
  {
    name: 'skillops_bench',
    description: '运行 SkillBench 基准评测套件，返回每个技能的 0-100 质量分',
    inputSchema: {
      type: 'object',
      properties: {
        skillsRoot: { type: 'string', description: '技能根目录，默认当前目录' },
        suite: { type: 'string', description: '套件 id，默认 basic' },
      },
    },
  },
  {
    name: 'skillops_report',
    description: '为技能目录生成自包含 HTML 可视化报告，返回报告路径与大小',
    inputSchema: {
      type: 'object',
      properties: {
        skillsRoot: { type: 'string', description: '技能根目录，默认当前目录' },
        output: { type: 'string', description: '报告输出路径，默认 ./skillops-report.html' },
      },
    },
  },
];

function analysisFor(root, configPath) {
  const config = loadConfig(root, configPath);
  const skills = scanSmartDir(root, 'mcp');
  return runAnalysis(skills, config);
}

async function handleCall(name, args = {}) {
  const root = path.resolve(args.skillsRoot || process.cwd());
  if (name === 'skillops_doctor') {
    const analysis = analysisFor(root);
    return JSON.stringify({ score: analysis.score, grade: analysis.grade, ...analysis }, null, 2);
  }
  if (name === 'skillops_bench') {
    const suite = loadSuite(args.suite || 'basic');
    const config = loadConfig(root);
    const skills = scanSmartDir(root, 'mcp');
    return JSON.stringify(runSuite(skills, suite, {}), null, 2);
  }
  if (name === 'skillops_report') {
    const analysis = analysisFor(root);
    const outPath = path.resolve(args.output || 'skillops-report.html');
    const html = buildReport(analysis, { scope: root, version: VERSION });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, 'utf8');
    const stat = fs.statSync(outPath);
    return JSON.stringify({ path: outPath, bytes: stat.size, score: analysis.score, grade: analysis.grade }, null, 2);
  }
  throw new Error(`未知工具: ${name}`);
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export function startMcpServer() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let buffer = '';
  rl.on('line', (line) => {
    // 兼容 LSP 风格 Content-Length 帧：跳过头部行，正文按 JSON 处理
    if (/^Content-Length:\s*\d+$/i.test(line.trim())) {
      buffer = '';
      return;
    }
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: NAME, version: VERSION },
        },
      });
      return;
    }
    if (msg.method === 'notifications/initialized' || msg.method === 'ping') {
      if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      return;
    }
    if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params || {};
      handleCall(name, args)
        .then((text) => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: false } }))
        .catch((e) => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `SkillOps MCP 错误: ${e.message}` }], isError: true } }));
      return;
    }
    if (msg.id != null) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `不支持的方法: ${msg.method}` } });
    }
  });
  rl.on('close', () => process.exit(0));
}
