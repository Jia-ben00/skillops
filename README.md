# SkillOps — AI 编程 Skill 的治理与评测平台

> 装了一堆 Skill 之后，你知道哪些在每轮对话烧 token、哪些跟别的技能打架、哪些其实该删掉吗？
> SkillOps 就是回答这个问题的地方：**体检 → 评测 → 可视化报告 → 一键治理**。

SkillOps 是一个面向 Claude Code / Codex / Cursor / OpenCode 等 AI 编程工具的 Skill（技能）治理工具：

- **体检（doctor）**：扫描你安装的全部技能，量化每轮对话的上下文开销（常驻税 + 触发税），检测触发描述重叠、工作流冲突、高度重复、长期未更新、来源不明、危险脚本。
- **评测（bench）**：内置 SkillBench 多套件质量门禁（basic / docs / codegen），给每个技能一个 0-100 的质量分；支持接入外部 Agent CLI 做实测（实验性）。
- **报告（report）**：生成自包含的单文件 HTML 可视化报告，可离线打开、可分享。
- **治理（fix）**：给出停用 / 精简 / 合并 / 更新 / 复核建议；默认 dry-run 预览，`--apply` 才真正落盘（停用 = 重命名为 `*.disabled`，可逆）。
- **团队同步（sync）**：以 Git 仓库为单一事实源，`push` 上收技能、`pull` 下发到全员、`gate` 做版本门禁（版本落后即拦截），让团队技能版本收敛。
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
| `mcp` | 以 MCP 服务器模式运行（供 AI 客户端调用） | `skillops mcp` |
| `serve` | 团队版控制台（托管报告 + 体检 API） | `skillops serve --port 3000` |
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
│   ├── mcp.js            # MCP 服务器（doctor/bench/report 工具）
│   └── server.js         # 团队版控制台
├── test/                 # 测试与示例技能 fixtures（含 .mdc）
└── docker/               # 团队版部署
```

## Roadmap

- [x] MVP：doctor / report / bench / fix / serve
- [x] 团队策略：技能仓库同步 + 版本门禁（Git 单一事实源）
- [x] SkillBench 任务套件扩展（docs / codegen 静态门禁 + agent 实测模板）
- [x] MCP 接入（doctor / bench / report 三个工具，任意 MCP 客户端可调用）
- [x] 官方 Agent Skills 规范适配（SKILL.md / .mdc 统一模型 + `--tool` 过滤）

### 下一步（Ideas）

- [ ] 技能市场：从公开仓库扫描下载 / 订阅源更新
- [ ] CI 集成：GitHub Action 自动跑 gate 并 PR 拦截
- [ ] 更多 SkillBench 套件（security / i18n / 长文档）
- [ ] Web 工作台（报告 + 治理操作界面）

## 开发与测试

```bash
node scripts/gen-fixtures.js   # 重新生成确定性测试 fixture
npm test                       # node --test
npm run demo:report            # 生成演示报告
```

## License

MIT
