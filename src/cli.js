#!/usr/bin/env node
// SkillOps CLI 入口
import path from 'node:path';
import fs from 'node:fs';
import { scanFromArgs, loadConfig } from './scanner.js';
import { runAnalysis } from './analyzers/index.js';
import { buildReport } from './report.js';
import { loadSuite, listSuites } from './bench/suite.js';
import { runSuite } from './bench/runner.js';
import { loadTaskSet, listTaskSets } from './bench/eval/taskset.js';
import { runEval, VERDICT_LABEL, verdictExplanation } from './bench/eval/runner.js';
import { describeBackend } from './bench/eval/agent.js';
import { buildEvalReport } from './bench/eval/report.js';
import { plan, execute } from './fix.js';
import { startServer, setSkillsDir, setPort } from './server.js';
import { estimateTokens } from './util.js';
import { VERSION } from './version.js';

const HELP = `SkillOps v${VERSION} — AI 编程 Skill 的治理与评测平台

用法:
  skillops doctor [目录...]           体检：扫描 + 上下文税/冲突/重复/过期/安全
  skillops report [目录...]          生成自包含 HTML 可视化报告（默认 skillops-report.html）
  skillops bench [--suite <id>]      运行 SkillBench 基准评测（默认套件 basic）
  skillops eval [目录...]             A/B 对照实验：量化技能对任务成功率的真实提升（lift）
  skillops fix [--apply] [--target <n>]  治理：默认 dry-run 预览，--apply 才落盘
  skillops sync <init|push|register|gate|pull> <teamRepo>  团队策略：Git 单一事实源 + 版本门禁
  skillops market <search|install|subscribe|update|list>  技能市场：扫描公开仓库 / 订阅源更新
  skillops mcp                     以 MCP 服务器模式运行（供 AI 客户端调用）
  skillops serve [dir] [--port <n>]  启动 Web 工作台（报告可视化 + 治理操作）
  skillops init                      生成 .skillopsrc.json 配置模板

选项:
  --json                输出 JSON（doctor / bench / eval）
  -o, --output <path>   报告输出路径
  --suite <id>          评测套件（可用: ${listSuites().join(', ')}），或自定义 JSON 路径
  --tasks <id|path>     eval 任务集（可用: ${listTaskSets().join(', ')}），或自定义 JSON 路径
  --agent <cmd>         后端选择：bench 用外部 Agent CLI 实测（如 "claude -p"）；
                        eval 用 "mock"（默认，确定性零成本）或外部 Agent CLI
  --repeat <n>          eval 每个条件的重复次数（默认 3；次数越多噪声越小，成本线性增长）
  --threshold <n>       eval 判定阈值（百分点，默认 10）：|lift| 低于此值判为装饰品
  --add <dir>           追加扫描目录（可重复）
  --no-defaults         只扫描显式指定目录（不探测 ~/.claude/skills 等默认位置）
  --tool <name>         只体检指定工具格式：claude/codex（SKILL.md）或 cursor（.mdc），默认全部
  --from <dir>          sync push 的本地来源目录
  --to <dir>            sync pull 的本地目标目录
  --local <dir>         sync gate 的本地技能目录
  --strict             sync gate 严格模式：未收录/未安装也计为错误（CI 用）
  --limit <n>          market search 返回仓库数（默认 10，探测前 3）
  --skill <n>          market 选中仓库内的技能序号（默认 0）
  --force              market install 覆盖已存在技能
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
  skillops eval test/fixtures --no-defaults --repeat 3
  skillops eval --tasks codegen-basic --agent "claude -p" --repeat 2 -o eval.html
  skillops fix --apply --target my-skill
`;

function parseArgs(argv) {
  const flags = { dirs: [], add: [], json: false, output: null, suite: null, agent: null, taskTemplate: null, dryRun: false, apply: false, target: null, config: null, port: null, version: false, help: false, noDefaults: false, tool: null, from: null, to: null, local: null, strict: false, limit: 10, skill: 0, force: false, tasks: null, repeat: 3, threshold: 10 };
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
    else if (a === '--tasks') flags.tasks = argv[++i];
    else if (a === '--agent') flags.agent = argv[++i];
    else if (a === '--repeat') flags.repeat = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--threshold') flags.threshold = Number(argv[++i]) || 0;
    else if (a === '--task-template') flags.taskTemplate = argv[++i];
    else if (a === '--target') flags.target = argv[++i];
    else if (a === '--config') flags.config = argv[++i];
    else if (a === '--no-defaults') flags.noDefaults = true;
    else if (a === '--tool') flags.tool = argv[++i];
    else if (a === '--from') flags.from = argv[++i];
    else if (a === '--to') flags.to = argv[++i];
    else if (a === '--local') flags.local = argv[++i];
    else if (a === '--strict') flags.strict = true;
    else if (a === '--limit') flags.limit = Number(argv[++i]) || 10;
    else if (a === '--skill') flags.skill = Number(argv[++i]) || 0;
    else if (a === '--force') flags.force = true;
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

function textEval(result) {
  const out = [];
  const t = result.totals;
  out.push(`SkillOps A/B 对照实验 — ${result.taskset.name}（${result.taskset.taskCount} 个任务 × ${result.config.repeat} 次重复）`);
  out.push(`后端 ${describeBackend({ name: result.backend })} | 判定阈值 ${result.config.threshold} 个百分点`);
  out.push('');
  out.push(
    `结论：有效 ${t.skillCount - t.decorativeCount - t.harmfulCount} 个 | 装饰品 ${t.decorativeCount} 个 | 有害 ${t.harmfulCount} 个 | 平均 lift ${t.avgLift}pp`,
  );
  out.push('');
  out.push(
    printTable(
      ['技能', 'A组(注入)', 'B组(裸跑)', 'lift', '判定'],
      result.skills.map((s) => [
        s.skill,
        `${s.treatment.passed}/${s.treatment.total} (${Math.round(s.treatment.rate * 100)}%)`,
        `${s.control.passed}/${s.control.total} (${Math.round(s.control.rate * 100)}%)`,
        `${s.lift > 0 ? '+' : ''}${s.lift}pp`,
        VERDICT_LABEL[s.verdict] || s.verdict,
      ]),
    ),
  );

  if (result.decorativeSkills.length || result.harmfulSkills.length) {
    out.push('');
    out.push('需要处理的技能：');
    for (const s of result.skills.filter((x) => x.verdict !== 'useful')) {
      out.push(`  [${VERDICT_LABEL[s.verdict]}] ${s.skill} — ${verdictExplanation(s.lift, result.config.threshold)}`);
      const weakest = s.tasks.filter((task) => task.lift < 0).slice(0, 2);
      for (const task of weakest) {
        out.push(`      退化于「${task.title}」：A 组 ${task.treatment.passed}/${task.treatment.total} vs B 组 ${task.control.passed}/${task.control.total}`);
      }
    }
  }

  out.push('');
  out.push('口径说明：');
  out.push('  · lift = A 组通过率 − B 组通过率（百分点）。唯一自变量是「是否注入 SKILL.md」，其余条件完全相同。');
  out.push('  · 判定成功后由判定命令客观裁决（退出码 + 输出片段断言），无人工阅读环节，故结论可复现。');
  out.push('  · lift 是相对量：它衡量该技能在这套任务集上的增益。任务集没考到它擅长的动作时，lift 会接近 0。');
  if (result.config.repeat < 3) {
    out.push(`  · 当前 repeat=${result.config.repeat}，噪声较大，建议 --repeat 5 以上再下结论。`);
  }
  if (result.backend === 'mock') {
    out.push('  · 当前为 mock 后端：确定性模拟，用于验证框架本身；真实提升幅度需用 --agent 接真实 Agent CLI 复测。');
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
    setPort(flags.port || process.env.PORT);
    if (flags.dirs[0]) setSkillsDir(path.resolve(flags.dirs[0]));
    startServer();
    return;
  }

  if (flags.command === 'sync') {
    await runSync(flags);
    return;
  }

  if (flags.command === 'mcp') {
    const { startMcpServer } = await import('./mcp.js');
    startMcpServer();
    return;
  }

  if (flags.command === 'market') {
    await runMarket(flags);
    return;
  }

  const { roots, skills: scanned } = scanFromArgs({
    cwd,
    config,
    extraDirs: flags.dirs.concat(flags.add),
    noDefaults: flags.noDefaults,
  });
  // --tool 过滤：claude/codex → agent-skill（SKILL.md）；cursor → cursor-rule（.mdc）
  let skills = scanned;
  if (flags.tool) {
    const fmt = flags.tool === 'cursor' ? 'cursor-rule' : 'agent-skill';
    skills = scanned.filter((s) => s.format === fmt);
    if (!skills.length) {
      console.error(`--tool ${flags.tool} 下未发现技能（期望格式: ${fmt}）`);
      process.exitCode = 1;
      return;
    }
  }
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

  if (flags.command === 'eval') {
    const taskset = loadTaskSet(flags.tasks);
    if (!skills.length) {
      console.log('未扫描到任何技能，无法运行 A/B 实验。');
      return;
    }
    const evalSkills = flags.tool
      ? skills.filter((s) => s.format === (flags.tool === 'cursor' ? 'cursor-rule' : 'agent-skill'))
      : skills;

    const result = await runEval(evalSkills, taskset, {
      agent: flags.agent,
      repeat: flags.repeat,
      threshold: flags.threshold,
      onProgress: ({ done, total, skill }) => {
        if (!flags.json && total > 1 && done < total) {
          process.stderr.write(`  已评测 ${done}/${total} — ${skill}\n`);
        }
      },
    });

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(textEval(result));

    if (flags.output) {
      const html = buildEvalReport(result, { version: VERSION, scope: flags.dirs.join(', ') || '当前扫描范围' });
      fs.writeFileSync(flags.output, html, 'utf8');
      console.log('');
      console.log(`HTML 报告已生成: ${flags.output}`);
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

async function runSync(flags) {
  const [sub, repo] = flags.dirs;
  if (!sub || !repo) {
    console.error('用法: skillops sync <init|push|register|gate|pull> <teamRepo>');
    process.exitCode = 1;
    return;
  }
  const { initTeamRepo, pushSkills, buildRegistry, gateSkills, pullSkills } = await import('./sync.js');
  const regPath = (r) => path.join(r, '.skillops', 'registry.json');
  switch (sub) {
    case 'init': {
      const created = initTeamRepo(repo);
      console.log(`团队仓库已初始化: ${repo}`);
      for (const f of created) console.log(`  ✓ ${f}`);
      break;
    }
    case 'push': {
      const from = flags.from || process.cwd();
      const { changed, registryWritten } = pushSkills(repo, from, { apply: flags.apply });
      for (const c of changed) console.log(`  ${c.result}`);
      if (registryWritten) console.log('  ✓ registry.json 已更新');
      if (!flags.apply) console.log('\n以上为预览（dry-run），加 --apply 才会真正写入。');
      break;
    }
    case 'register': {
      const reg = buildRegistry(repo);
      const count = Object.keys(reg.skills).length;
      if (!flags.apply) {
        console.log(`[dry-run] 将更新 registry.json（${count} 个技能）`);
      } else {
        fs.writeFileSync(regPath(repo), JSON.stringify(reg, null, 2) + '\n', 'utf8');
        console.log(`registry.json 已更新（${count} 个技能）`);
      }
      break;
    }
    case 'gate': {
      const local = flags.local || process.cwd();
      const { results, passed } = gateSkills(repo, local, { strict: flags.strict });
      for (const r of results) {
        const mark = r.level === 'error' ? '✗' : r.level === 'ok' ? '✓' : 'i';
        console.log(`  ${mark} [${r.status}] ${r.name}: ${r.message}`);
      }
      console.log(passed ? '\n门禁通过 ✓' : '\n门禁未通过 ✗（存在版本落后或未同步项）');
      if (!passed) process.exitCode = 1;
      break;
    }
    case 'pull': {
      const to = flags.to || process.cwd();
      const { changed } = pullSkills(repo, to, { apply: flags.apply });
      for (const c of changed) console.log(`  ${c.result}`);
      if (!flags.apply) console.log('\n以上为预览（dry-run），加 --apply 才会真正写入。');
      break;
    }
    default:
      console.error(`未知 sync 子命令: ${sub}`);
      process.exitCode = 1;
  }
}

async function runMarket(flags) {
  const [sub, arg] = flags.dirs;
  const market = await import('./market.js');
  const { ghFetch, searchRepos, discoverSkills, downloadSkill, subscribe, updateAll, loadSubscriptions, parseRepoArg } = market;
  const fetchImpl = globalThis.fetch;
  const home = await import('node:os').then((o) => o.homedir());
  const target = flags.target || path.join(home, '.claude', 'skills');

  switch (sub) {
    case 'search': {
      const query = arg || 'skills in:name,description';
      console.log(`搜索公开仓库: ${query}`);
      const repos = await searchRepos(fetchImpl, query, { limit: flags.limit });
      if (!repos.length) {
        console.log('未找到匹配仓库。');
        return;
      }
      console.log(printTable(
        ['仓库', '⭐', '默认分支', '描述'],
        repos.map((r) => [r.fullName, r.stars, r.defaultBranch, r.description]),
      ));
      console.log('');
      console.log(`探测前 ${Math.min(3, repos.length)} 个仓库中的技能...`);
      for (const r of repos.slice(0, 3)) {
        try {
          const d = await discoverSkills(fetchImpl, r.fullName);
          console.log(`\n${r.fullName}（${d.skills.length} 个技能）: ${d.skills.map((s, i) => `[${i}] ${s.name} (${s.format})`).join(' · ')}`);
        } catch (e) {
          console.log(`\n${r.fullName}: ${e.message}`);
        }
      }
      console.log('\n安装: skillops market install <owner/repo> [--skill <n>] [--target <dir>] [--apply]');
      return;
    }
    case 'install': {
      if (!arg) {
        console.error('用法: skillops market install <owner/repo> [--skill <n>] [--target <dir>] [--apply]');
        process.exitCode = 1;
        return;
      }
      const repo = parseRepoArg(arg);
      const d = await discoverSkills(fetchImpl, `${repo.owner}/${repo.repo}`);
      if (!d.skills.length) {
        console.error('该仓库未发现技能（无 SKILL.md / .mdc）。');
        process.exitCode = 1;
        return;
      }
      const skill = d.skills[flags.skill];
      if (!skill) {
        console.error(`技能序号 ${flags.skill} 不存在，可用 0-${d.skills.length - 1}。`);
        process.exitCode = 1;
        return;
      }
      const dest = path.join(target, skill.name);
      if (fs.existsSync(dest) && !flags.force) {
        console.error(`目标已存在: ${dest}（加 --force 覆盖，或先 sync gate 检查版本）`);
        process.exitCode = 1;
        return;
      }
      console.log(`下载 ${d.owner}/${d.repo}@${d.branch} → ${skill.name} (${skill.files.length} 个文件)`);
      const files = await downloadSkill(fetchImpl, d, flags.skill, { onProgress: (p) => console.log(`  · ${p}`) });
      if (!flags.apply) {
        console.log(`\n[dry-run] 将安装到 ${dest}，加 --apply 落盘。`);
        return;
      }
      fs.mkdirSync(dest, { recursive: true });
      for (const f of files.files) {
        const rel = f.relPath.replace(`${skill.root}${skill.root ? '/' : ''}`, '');
        const p = path.join(dest, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, f.content);
      }
      console.log(`\n已安装到 ${dest}（${files.files.length} 个文件，sha256 校验通过）`);
      return;
    }
    case 'subscribe': {
      if (!arg) {
        console.error('用法: skillops market subscribe <owner/repo> [--skill <n>] [--target <dir>]');
        process.exitCode = 1;
        return;
      }
      const repo = parseRepoArg(arg);
      const d = await discoverSkills(fetchImpl, `${repo.owner}/${repo.repo}`);
      if (!d.skills.length) {
        console.error('该仓库未发现技能。');
        process.exitCode = 1;
        return;
      }
      if (!d.skills[flags.skill]) {
        console.error(`技能序号 ${flags.skill} 不存在，可用 0-${d.skills.length - 1}。`);
        process.exitCode = 1;
        return;
      }
      const { entry, added } = subscribe(fetchImpl, `${repo.owner}/${repo.repo}`, { skillIndex: flags.skill, target });
      console.log(`${added ? '已订阅' : '订阅已更新'}: ${entry.repo} [${flags.skill}] → ${target}`);
      console.log('之后运行 skillops market update [--apply] 拉取更新。');
      return;
    }
    case 'update': {
      const results = await updateAll(fetchImpl, { apply: flags.apply });
      for (const r of results) {
        if (r.status === 'error') {
          console.log(`  ✗ ${r.repo} [${r.skillIndex}]: ${r.message}`);
          continue;
        }
        const detail = r.changed.length ? r.changed.map((c) => `${c.action} ${c.relPath}`).join('; ') : '无变化';
        console.log(`  ${r.changed.length ? '✓' : 'i'} ${r.repo} [${r.skillIndex}] ${r.skill}: ${detail}`);
      }
      if (!flags.apply) console.log('\n以上为预览（dry-run），加 --apply 才会真正写入。');
      return;
    }
    case 'list': {
      const list = loadSubscriptions();
      if (!list.length) {
        console.log('暂无订阅。用 skillops market subscribe <owner/repo> 添加。');
        return;
      }
      console.log(printTable(
        ['仓库', '技能#', '安装目录', '上次更新'],
        list.map((s) => [s.repo, s.skillIndex, s.target, s.lastUpdate || '—']),
      ));
      return;
    }
    default:
      console.error('用法: skillops market <search|install|subscribe|update|list>');
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`SkillOps 错误: ${e.message}`);
  if (/fetch failed|UNABLE_TO_VERIFY|ECONNREFUSED|ENOTFOUND|socket hang up|502|timed out/i.test(e.message || '')) {
    console.error('网络请求失败。若在公司代理 / 自签证书环境，可尝试：');
    console.error('  PowerShell:  $env:NODE_TLS_REJECT_UNAUTHORIZED="0"  后再运行 market 命令');
    console.error('  Node 22+:    node --use-system-ca src/cli.js market ...');
    console.error('或设置 GITHUB_TOKEN 提升 API 速率限制。');
  }
  process.exitCode = 1;
});
