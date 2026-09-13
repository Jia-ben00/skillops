#!/usr/bin/env node
// SkillOps CLI 入口
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scanFromArgs, loadConfig } from './scanner.js';
import { runAnalysis } from './analyzers/index.js';
import { buildReport } from './report.js';
import { loadSuite, listSuites } from './bench/suite.js';
import { runSuite } from './bench/runner.js';
import { plan, execute } from './fix.js';
import { startServer } from './server.js';
import { estimateTokens } from './util.js';

const VERSION = '0.1.0';

const HELP = `SkillOps v${VERSION} — AI 编程 Skill 的治理与评测平台

用法:
  skillops doctor [目录...]           体检：扫描 + 上下文税/冲突/重复/过期/安全
  skillops report [目录...]          生成自包含 HTML 可视化报告（默认 skillops-report.html）
  skillops bench [--suite <id>]      运行 SkillBench 基准评测（默认套件 basic）
  skillops fix [--apply] [--target <n>]  治理：默认 dry-run 预览，--apply 才落盘
  skillops serve [--port <n>]        启动团队版控制台（托管报告 + 体检 API）
  skillops init                      生成 .skillopsrc.json 配置模板

选项:
  --json                输出 JSON（doctor / bench）
  -o, --output <path>   报告输出路径
  --suite <id>          评测套件（可用: ${listSuites().join(', ')}），或自定义 JSON 路径
  --agent <cmd>         SkillBench 实验模式：用外部 Agent CLI 实测（如 "claude -p"）
  --add <dir>           追加扫描目录（可重复）
  --no-defaults         只扫描显式指定目录（不探测 ~/.claude/skills 等默认位置）
  --config <path>       配置文件路径（默认 ./.skillopsrc.json）
  --dry-run / --apply   fix 的预览 / 执行开关（默认 dry-run）
  --target <name>       fix 只处理指定技能
  -v, --version         版本
  -h, --help            帮助

示例:
  skillops doctor
  skillops doctor ~/.claude/skills --json
  skillops report --add ./my-skills -o my-report.html
  skillops bench --suite basic --json
  skillops fix --apply --target my-skill
`;

function parseArgs(argv) {
  const flags = { dirs: [], add: [], json: false, output: null, suite: null, agent: null, taskTemplate: null, dryRun: false, apply: false, target: null, config: null, port: null, version: false, help: false, noDefaults: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--apply') flags.apply = true;
    else if (a === '-v' || a === '--version') flags.version = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '-o' || a === '--output') flags.output = argv[++i];
    else if (a === '--suite') flags.suite = argv[++i];
    else if (a === '--agent') flags.agent = argv[++i];
    else if (a === '--task-template') flags.taskTemplate = argv[++i];
    else if (a === '--target') flags.target = argv[++i];
    else if (a === '--config') flags.config = argv[++i];
    else if (a === '--no-defaults') flags.noDefaults = true;
    else if (a === '--port') flags.port = argv[++i];
    else if (a === '--add') flags.add.push(argv[++i]);
    else if (a.startsWith('-')) throw new Error(`未知选项: ${a}`);
    else positional.push(a);
  }
  flags.command = positional[0] || (flags.version ? 'version' : 'help');
  flags.dirs = positional.slice(1);
  return flags;
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] || '').length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  const sep = headers.map((_, i) => '-'.repeat(widths[i])).join('  ');
  return [line(headers), sep, ...rows.map((r) => line(r))].join('\n');
}

function textDoctor(analysis) {
  const t = analysis.totals;
  const out = [];
  out.push(`SkillOps 体检完成 — 综合分 ${analysis.score}（${analysis.grade}）`);
  out.push(`技能 ${t.skillCount} 个 | 常驻税 ${t.listingTax} tok/轮 | 触发税 ${t.triggerTax} tok/次 | 问题 error=${t.bySeverity.error} warn=${t.bySeverity.warn} info=${t.bySeverity.info}`);
  out.push('');
  out.push(printTable(
    ['技能', '来源', '分', '级', '常驻税', '触发税', '行数', '问题'],
    analysis.skills.map((s) => [s.name, s.source, s.score, s.grade, s.listingTax, s.triggerTax, s.lines, s.issueCount]),
  ));
  if (analysis.issues.length) {
    out.push('');
    out.push('问题清单:');
    for (const i of analysis.issues.slice(0, 40)) {
      out.push(`  [${i.severity}] ${i.skill} ${i.message}`);
    }
    if (analysis.issues.length > 40) out.push(`  … 其余 ${analysis.issues.length - 40} 项见 HTML 报告`);
  }
  if (analysis.suggestions.length) {
    out.push('');
    out.push('治理建议（skillops fix 预览）:');
    for (const s of analysis.suggestions) out.push(`  ${s.action}: ${s.skill} — ${s.reason}`);
  }
  return out.join('\n');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.command === 'help') {
    console.log(HELP);
    return;
  }
  if (flags.version || flags.command === 'version') {
    console.log(VERSION);
    return;
  }

  const cwd = process.cwd();
  const config = loadConfig(cwd, flags.config);

  if (flags.command === 'init') {
    const target = flags.config || path.join(cwd, '.skillopsrc.json');
    if (fs.existsSync(target)) {
      console.log(`已存在: ${target}（未覆盖）`);
      return;
    }
    const template = {
      skillRoots: [],
      staleDays: 180,
      budgets: { descChars: 1536, skillLines: 500, listingTax: 380, triggerTax: 4000, scorePass: 60 },
      ignore: [],
    };
    fs.writeFileSync(target, JSON.stringify(template, null, 2) + '\n', 'utf8');
    console.log(`已生成配置模板: ${target}`);
    return;
  }

  if (flags.command === 'serve') {
    process.env.PORT = String(flags.port || process.env.PORT || 3000);
    startServer();
    return;
  }

  const { roots, skills } = scanFromArgs({
    cwd,
    config,
    extraDirs: flags.dirs.concat(flags.add),
    noDefaults: flags.noDefaults,
  });
  if (!skills.length) {
    console.error('未发现任何技能（无 SKILL.md）。可指定目录: skillops doctor <dir>，或用 --add <dir>');
    process.exitCode = 1;
    return;
  }

  if (flags.command === 'doctor') {
    const analysis = runAnalysis(skills, config);
    if (flags.json) {
      console.log(JSON.stringify({ scope: roots, ...analysis }, null, 2));
    } else {
      console.log(textDoctor(analysis));
    }
    return;
  }

  if (flags.command === 'report') {
    const analysis = runAnalysis(skills, config);
    const outPath = path.resolve(flags.output || 'skillops-report.html');
    const html = buildReport(analysis, {
      scope: roots.map((r) => r.dir).join('; '),
      version: VERSION,
    });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(`报告已生成: ${outPath}`);
    return;
  }

  if (flags.command === 'bench') {
    const suite = flags.suite && fs.existsSync(flags.suite)
      ? JSON.parse(fs.readFileSync(flags.suite, 'utf8'))
      : loadSuite(flags.suite || 'basic');
    const result = runSuite(skills, suite, { agent: flags.agent, taskTemplate: flags.taskTemplate });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const rows = result.results.map((r) => [
        r.skill,
        r.score,
        r.grade,
        r.checks.filter((c) => c.pass).length + '/' + r.checks.length,
        r.agent ? `${r.agent.exitCode ?? '?'} / ${r.agent.durationMs}ms` : '-',
      ]);
      console.log(`SkillBench 套件「${result.suite.name}」 — 平均 ${result.avgScore}（${result.avgGrade}）`);
      console.log(printTable(['技能', '分', '级', '通过', 'Agent(exit/耗时)'], rows));
      if (flags.agent) {
        console.log('');
        console.log('注: Agent 实测为实验功能，成本与 token 为估算值。');
      }
    }
    return;
  }

  if (flags.command === 'fix') {
    const analysis = runAnalysis(skills, config);
    const items = plan(analysis, { target: flags.target });
    if (!items.length) {
      console.log('没有可自动执行的治理项（disable/update）。其余建议需人工处理。');
      return;
    }
    const { changed, skipped } = execute(items, analysis, { apply: flags.apply });
    for (const c of changed) console.log(`  ✓ ${c.result}`);
    for (const s of skipped) console.log(`  ! ${s.result}`);
    if (!flags.apply) {
      console.log('');
      console.log('以上为预览（dry-run），加 --apply 才会真正执行。');
    }
    return;
  }

  console.log(HELP);
}

main().catch((e) => {
  console.error(`SkillOps 错误: ${e.message}`);
  process.exitCode = 1;
});
