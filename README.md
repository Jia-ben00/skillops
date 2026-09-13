# SkillOps — AI 编程 Skill 的治理与评测平台

> 装了一堆 Skill 之后，你知道哪些在每轮对话烧 token、哪些跟别的技能打架、哪些其实该删掉吗？
> SkillOps 就是回答这个问题的地方：**体检 → 评测 → 可视化报告 → 一键治理**。

SkillOps 是一个面向 Claude Code / Codex / Cursor / OpenCode 等 AI 编程工具的 Skill（技能）治理工具：

- **体检（doctor）**：扫描你安装的全部技能，量化每轮对话的上下文开销（常驻税 + 触发税），检测触发描述重叠、工作流冲突、高度重复、长期未更新、来源不明、危险脚本。
- **评测（bench）**：内置 SkillBench 多套件质量门禁（basic / docs / codegen），给每个技能一个 0-100 的质量分；支持接入外部 Agent CLI 做实测（实验性）。
- **报告（report）**：生成自包含的单文件 HTML 可视化报告，可离线打开、可分享。
- **治理（fix）**：给出停用 / 精简 / 合并 / 更新 / 复核建议；默认 dry-run 预览，`--apply` 才真正落盘（停用 = 重命名为 `*.disabled`，可逆）。
- **团队同步（sync）**：以 Git 仓库为单一事实源，`push` 上收技能、`pull` 下发到全员、`gate` 做版本门禁（版本落后即拦截），让团队技能版本收敛。
- **Web 工作台（serve）**：一键启动可视化控制台——概览仪表盘 + SVG 图表（评分/上下文税/问题分布/格式分布）+ 技能明细 + 治理操作界面（预览/执行，`--apply` 语义一致）。
- **技能市场（market）**：扫描公开 GitHub 仓库发现技能（SKILL.md / .mdc），一键安装到本地；订阅仓库后 `market update` 增量拉取更新（sha256 比对，dry-run 默认）。
- **MCP 接入**：`skillops mcp` 以 MCP 服务器模式运行，Claude Desktop / Cursor 等任意 MCP 客户端可直接调用体检 / 评测 / 报告工具。
- **多格式统一**：同时识别 Agent Skills（`SKILL.md`）与 Cursor Rules（`.mdc`），统一为同一模型体检、评分、治理。

**零依赖**：纯 Node.js 标准库实现，无需 `npm install`，无需数据库，本地运行、默认不出网。

---

## 快速开始

环境要求：Node.js ≥ 18。

```bash
# 方式一：直接跑（无需安装）
git clone <repo-url> && cd skillops
node src/cli.js doctor

# 方式二：全局安装（推荐）
npm install -g .
skillops doctor ~/.claude/skills

# 方式三：用 npx 指向本仓库
npx skillops doctor
```

> `skillops doctor` 默认自动探测：`~/.claude/skills`、项目级 `.claude/skills`、`.codex/skills`、`.cursor/skills`，以及 `SKILLOPS_SKILLS` 环境变量与 `.skillopsrc.json` 中配置的目录。
> 只想扫描指定目录：`skillops doctor <dir> --no-defaults`。

### 命令参考

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `doctor` | 体检：扫描 + 上下文税/冲突/重复/过期/安全 | `skillops doctor --json` |
| `report` | 生成自包含 HTML 可视化报告 | `skillops report -o skillops-report.html` |
| `bench` | 运行 SkillBench 基准评测（basic/docs/codegen） | `skillops bench --suite codegen --json` |
| `fix` | 治理：默认 dry-run 预览，`--apply` 落盘 | `skillops fix --apply --target my-skill` |
| `sync` | 团队同步：init/push/register/gate/pull | `skillops sync gate .team --local .` |
| `market` | 技能市场：search/install/subscribe/update/list | `skillops market install owner/repo --apply` |
| `mcp` | 以 MCP 服务器模式运行（供 AI 客户端调用） | `skillops mcp` |
| `serve` | Web 工作台：仪表盘 + 图表 + 治理操作（指定目录） | `skillops serve test/fixtures --port 3000` |
| `init` | 生成 `.skillopsrc.json` 配置模板 | `skillops init` |

> `doctor / report / bench / fix` 都支持 `--tool <claude|cursor|codex>` 只处理指定工具格式（`cursor` 对应 `.mdc` 规则）。

### 团队同步与版本门禁（sync）

以 Git 仓库为单一事实源，让团队技能版本收敛：

```bash
# 1. 初始化团队仓库（生成 skills/ + .skillops/registry.json）
skillops sync init /path/to/team-repo

# 2. 上收本地技能到团队仓库并重建 registry（dry-run 预览，--apply 落盘）
skillops sync push /path/to/team-repo --from ~/.claude/skills --apply
cd /path/to/team-repo && git add -A && git commit -m "sync skills" && git push

# 3. 全员拉取（默认 dry-run）
skillops sync pull /path/to/team-repo --to ~/.claude/skills --apply

# 4. CI/本地门禁：本地版本落后于团队仓库时退出码为 1，阻断发布
skillops sync gate /path/to/team-repo --local ~/.claude/skills
```

- 版本优先读 frontmatter 的 `version`（语义化比较）；没有版本号时退化为目录内容校验和比对。
- 所有写操作默认 dry-run，`--apply` 才落盘，安全可逆。

## 体检项说明（口径）

| 维度 | 检测项 | 阈值（默认） |
| --- | --- | --- |
| 上下文税 | 常驻税（名称+描述，每轮加载） | 预算 380 tokens/轮 |
| | 触发税（SKILL.md 正文，调用时加载） | 预算 4000 tokens/次 |
| | 描述长度 | ≤ 1536 字符 |
| | SKILL.md 行数 | ≤ 500 行 |
| | 内联脚本 | ≤ 3000 tokens |
| 冲突与重复 | 触发描述重叠（CJK 2-gram 交集） | 共享 ≥ 4 个语义片段 |
| | 工作流冲突（只读 vs 写入指令） | 成对检测 |
| | 高度重复 | 描述重叠度 ≥ 80% |
| 过期与来源 | 未更新天数 | > 180 天 |
| | 来源可信度 | 无 license/版本/仓库信息 |
| 脚本安全 | 下载即执行 / rm -rf / IEX / eval / 数据外传 等 | 启发式规则，需人工复核 |

**token 为估算值**：CJK 字符 1 字符 ≈ 1 token，其余字符 4 字符 ≈ 1 token。
**评分为扣分制**：100 分起步，error −15 / warn −8 / info −3；A ≥ 90，B ≥ 75，C ≥ 60，D < 60。

## SkillBench 套件

内置多套件静态质量门禁（无需调用模型）：

| 套件 | 适用技能 | 检查项 |
| --- | --- | --- |
| `basic` | 通用 | frontmatter / 描述 / 行数 / 内联脚本 / 来源信息 |
| `docs` | 文档 / PDF / 知识库处理 | 示例、渐进式披露（supporting files）、触发词、来源 |
| `codegen` | 代码生成 / 重构 / 测试 | 技术栈、验证/测试步骤、示例、内联脚本预算 |

```bash
skillops bench --suite basic --json
skillops bench --suite codegen --json
skillops bench --agent "claude -p" --suite codegen   # 实验性：外部 Agent 实测
```

## 技能市场（market）

零依赖扫描公开 GitHub 仓库、安装技能、订阅更新（仅用 Node 内置 fetch；未认证限流约 10 次/分，设置 `GITHUB_TOKEN` 可提升）：

```bash
# 1. 搜索仓库并探测其中技能（默认取 star 最高的前 3 个仓库探测）
skillops market search "skills in:name,description"
skillops market search "topic:claude-code"

# 2. 安装（默认 dry-run，--apply 落盘到 ~/.claude/skills；--target 可指定目录）
skillops market install owner/repo --apply
skillops market install owner/repo --skill 1 --target ~/.cursor/skills --apply

# 3. 订阅源更新：记录仓库+技能+安装目录，之后增量拉取（sha256 比对，无变化不写盘）
skillops market subscribe owner/repo --target ~/.claude/skills
skillops market update          # dry-run 预览
skillops market update --apply  # 真正拉取变更
skillops market list
```

- 发现机制：仓库搜索 API → git trees API 一次拿全树 → 聚合技能目录（含 SKILL.md 与 .mdc）→ 下载（raw 优先，失败自动回退 contents API）。
- 安装/更新均有 sha256 校验；订阅文件存于 `~/.skillops/subscriptions.json`。
- 网络提示：未认证 GitHub API 限流约 10 次/分，设置 `GITHUB_TOKEN` 可提升；公司代理/自签证书环境下 Node fetch 可能失败，可用 `node --use-system-ca src/cli.js`（Node 22+）或 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过。

## MCP 接入

`skillops mcp` 以零依赖 MCP 服务器模式运行（JSON-RPC over stdio），暴露三个工具：

| 工具 | 说明 |
| --- | --- |
| `skillops_doctor` | 对指定目录运行体检，返回 JSON 分析结果 |
| `skillops_bench` | 运行 SkillBench 套件，返回每个技能的质量分 |
| `skillops_report` | 生成自包含 HTML 报告，返回路径与大小 |

Claude Desktop 配置示例（`claude_desktop_config.json`）：

```json
{ "mcpServers": { "skillops": { "command": "node", "args": ["/path/to/skillops/src/cli.js", "mcp"] } } }
```

## CI 集成（GitHub Action）

把版本门禁变成自动化：任何 PR 若改了技能但没同步 `registry.json`、或版本回退，Action 直接失败拦截。

**方案一：用现成 Action**（任意技能仓库，仓库含 `skills/` 与 `.skillops/registry.json`）：

```yaml
# .github/workflows/skill-gate.yml
name: Skill Gate
on:
  pull_request:
    paths: ['skills/**', '.skillops/**']
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Jia-ben00/skillops/.github/actions/skill-gate@main
        with:
          skills-path: skills
          registry-path: .skillops/registry.json
          strict: 'true'   # 未收录/未安装的技能也拦截
```

**方案二：本仓库自带 CI**（`.github/workflows/ci.yml`）：`npm test` + 团队仓库自检（init → push → gate --strict）+ Action 正/负例验证。

`strict` 门禁语义：版本落后 / 未收录 / 未安装 → error → 退出码 1；`--strict` 也可在本地用：`skillops sync gate .team --local .team/skills --strict`。

## Web 工作台（serve）

一键启动可视化控制台（零依赖，浏览器打开即用）：

```bash
skillops serve                      # 默认扫描当前目录
skillops serve ~/.claude/skills --port 3000
```

- **仪表盘**：综合分/等级、技能数、上下文税合计、问题统计卡片。
- **图表**（自绘 SVG，离线可用）：技能评分排行、常驻/触发税 Top 8、问题严重程度分布、技能格式分布。
- **技能明细**：表格 + 点击展开问题清单与 frontmatter（版本/license/来源）。
- **治理操作**：建议列表（自动项 `disable`/`update` 带标签），先「预览」看 dry-run 结果，确认后「执行」；执行前有确认弹窗，服务端只接受体检结果内的技能名（防路径注入）。
- **报告**：一键生成完整 HTML 报告并自动打开。

API（同时兼容 Docker 部署）：`GET /api/health` · `GET /api/skills?dir=` · `POST /api/doctor` · `POST /api/fix/plan` · `POST /api/fix/apply` · `GET /api/report?dir=` · `GET /reports/*`。

## 真实案例自举

不拿合成数据自夸——用真实公开仓库跑一遍：从三个 GitHub 仓库安装 10 个真实技能并体检（2026-09 快照，复现命令见下）：

```
SkillOps 体检完成 — 综合分 97（A）
技能 10 个 | 常驻税 1039 tok/轮 | 触发税 28544 tok/次 | 问题 error=0 warn=2 info=5
```

| 技能 | 来源 | 分 | 级 | 常驻税 | 触发税 | 行数 |
| --- | --- | --- | --- | --- | --- | --- |
| code-review | mattpocock/skills | 100 | A | 108 | 1546 | 88 |
| diagnosing-bugs | mattpocock/skills | 100 | A | 43 | 2115 | 139 |
| pdf | anthropics/skills | 100 | A | 111 | 1956 | 315 |
| systematic-debugging | obra/superpowers | 100 | A | 28 | 2326 | 284 |
| test-driven-development | obra/superpowers | 100 | A | 26 | 2217 | 321 |
| academy-guide | anthropics/skills | 97 | A | 4 | 1685 | 148 |
| docx | anthropics/skills | 97 | A | 210 | 1508 | 92 |
| xlsx | anthropics/skills | 97 | A | 239 | 1900 | 100 |
| pptx | anthropics/skills | 89 | B | 186 | 5014 | 239 |
| skill-creator | anthropics/skills | 89 | B | 84 | 8277 | 486 |

真实发现（这类问题只在真实数据上才看得见）：

- **pptx / skill-creator 触发税超预算**（5014 / 8277 tokens > 4000）：官方大型技能把模板全量写进 SKILL.md，调用时一次性加载——渐进式披露不足是真实世界最常见的烧 token 原因。
- **academy-guide 指令冲突**：同时包含多组"必须/禁止"指令，可能互相打架。

完整报告见 `examples/skillops-real-report.html`（已随仓库提交）。复现：

```bash
node scripts/bootstrap-real-skills.js   # git clone 三个公开仓库，安装精选 10 个技能到 examples/.cache（不提交）
node src/cli.js doctor examples/.cache/real-skills --no-defaults
node src/cli.js report examples/.cache/real-skills --no-defaults -o examples/skillops-real-report.html
```

> 技能文件本身不提交（尊重第三方 license），仓库只保留分析报告与复现脚本。

## 团队部署（Docker 一键）

个人版零依赖；团队版用 Docker Compose 一键起控制台：

```bash
cd docker
docker compose up -d
# 控制台: http://localhost:3000
# 报告目录挂载 ./reports，技能目录挂载 ./skills
```

控制台提供：`POST /api/doctor`（对指定技能目录运行体检，返回 JSON）、`/reports/`（查看已生成报告）。

## 配置 `.skillopsrc.json`

```json
{
  "skillRoots": ["D:/team/skills"],
  "staleDays": 180,
  "budgets": { "descChars": 1536, "skillLines": 500, "listingTax": 380, "triggerTax": 4000 },
  "ignore": []
}
```

## 项目结构

```
skillops/
├── src/
│   ├── cli.js            # CLI 入口
│   ├── scanner.js        # 跨工具/跨层级技能扫描（SKILL.md + .mdc）
│   ├── skillfile.js      # 多格式解析：SKILL.md / .mdc → 统一技能模型
│   ├── analyzers/        # 体检分析器（上下文税/冲突/安全/评分）
│   ├── bench/            # SkillBench 套件（basic/docs/codegen）与运行器
│   ├── report.js         # 自包含 HTML 可视化报告
│   ├── fix.js            # 治理执行（dry-run 默认）
│   ├── sync.js           # 团队同步 + 版本门禁（Git 单一事实源）
│   ├── market.js         # 技能市场（搜索/安装/订阅更新）
│   ├── mcp.js            # MCP 服务器（doctor/bench/report 工具）
│   ├── server.js         # Web 工作台（仪表盘 + 治理 API）
│   └── web/console.html  # 控制台前端（零依赖，SVG 图表）
├── test/                 # 测试与示例技能 fixtures（含 .mdc）
└── docker/               # 团队版部署
```

## Roadmap

- [x] MVP：doctor / report / bench / fix / serve
- [x] 团队策略：技能仓库同步 + 版本门禁（Git 单一事实源）
- [x] SkillBench 任务套件扩展（docs / codegen 静态门禁 + agent 实测模板）
- [x] MCP 接入（doctor / bench / report 三个工具，任意 MCP 客户端可调用）
- [x] 官方 Agent Skills 规范适配（SKILL.md / .mdc 统一模型 + `--tool` 过滤）
- [x] CI 集成：GitHub Action 自动跑 gate（`skill-gate` composite action + 自带 CI workflow）
- [x] 技能市场：扫描公开仓库（search）+ 安装（install）+ 订阅源更新（subscribe/update）
- [x] Web 工作台：报告可视化 + 治理操作界面（serve）

### 下一步（Ideas）

- [ ] 更多 SkillBench 套件（security / i18n / 长文档）
- [ ] 市场搜索接入 GitHub 话题/自建索引，提升发现质量
- [ ] 工作台鉴权与多目录管理（团队部署）

## 开发与测试

```bash
node scripts/gen-fixtures.js   # 重新生成确定性测试 fixture
npm test                       # node --test
npm run demo:report            # 生成演示报告
```

## License

MIT
