# SkillOps — AI 编程 Skill 的治理与评测平台

> 装了一堆 Skill 之后，你知道哪些在每轮对话烧 token、哪些跟别的技能打架、哪些其实该删掉吗？
> SkillOps 就是回答这个问题的地方：**体检 → 评测 → 可视化报告 → 一键治理**。

SkillOps 是一个面向 Claude Code / Codex / Cursor / OpenCode 等 AI 编程工具的 Skill（技能）治理工具：

- **体检（doctor）**：扫描你安装的全部技能，量化每轮对话的上下文开销（常驻税 + 触发税），检测触发描述重叠、工作流冲突、高度重复、长期未更新、来源不明、危险脚本。
- **评测（bench）**：内置 SkillBench 基础质量门禁套件，给每个技能一个 0-100 的质量分；支持接入外部 Agent CLI 做实测（实验性）。
- **报告（report）**：生成自包含的单文件 HTML 可视化报告，可离线打开、可分享。
- **治理（fix）**：给出停用 / 精简 / 合并 / 更新 / 复核建议；默认 dry-run 预览，`--apply` 才真正落盘（停用 = 重命名为 `*.disabled`，可逆）。

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
| `bench` | 运行 SkillBench 基准评测 | `skillops bench --suite basic --json` |
| `fix` | 治理：默认 dry-run 预览，`--apply` 落盘 | `skillops fix --apply --target my-skill` |
| `serve` | 团队版控制台（托管报告 + 体检 API） | `skillops serve --port 3000` |
| `init` | 生成 `.skillopsrc.json` 配置模板 | `skillops init` |

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

内置 `basic` 套件（纯静态质量门禁，无需调用模型）。后续可扩展：

- `--agent "claude -p"`：实验性接入外部 Agent CLI，让模型阅读技能并回答问题，记录耗时与输出量。

```bash
skillops bench --suite basic --json
skillops bench --agent "claude -p" --task-template "请阅读 {dir}/SKILL.md 并说明用途"
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
│   ├── scanner.js        # 跨工具/跨层级技能扫描
│   ├── skillfile.js      # SKILL.md 解析（frontmatter + 画像）
│   ├── analyzers/        # 体检分析器（上下文税/冲突/安全/评分）
│   ├── bench/            # SkillBench 套件与运行器
│   ├── report.js         # 自包含 HTML 可视化报告
│   ├── fix.js            # 治理执行（dry-run 默认）
│   └── server.js         # 团队版控制台
├── test/                 # 测试与示例技能 fixtures
└── docker/               # 团队版部署
```

## Roadmap

- [x] MVP：doctor / report / bench / fix / serve
- [ ] 团队策略：技能仓库同步 + 版本门禁（Git 单一事实源）
- [ ] SkillBench 任务套件扩展（文档处理、代码生成等实测基准）
- [ ] MCP 接入（任意 Agent 可调用体检能力）
- [ ] 官方 Agent Skills 规范适配（跨工具格式统一）

## 开发与测试

```bash
node scripts/gen-fixtures.js   # 重新生成确定性测试 fixture
npm test                       # node --test
npm run demo:report            # 生成演示报告
```

## License

MIT
