// Eval 任务集加载与校验
//
// 任务集格式（JSON）：
// {
//   "id": "codegen-basic",
//   "name": "...",
//   "description": "...",
//   "verifyTimeoutMs": 15000,
//   "tasks": [
//     {
//       "id": "fix-off-by-one",
//       "title": "...",
//       "prompt": "...",                       // 交给 Agent 的指令
//       "skillTags": ["code-review", "..."],   // 预期对该任务有帮助的技能名/标签
//       "workspace": { "相对路径": "文件内容" },  // 任务开始前的初始文件
//       "verify": {                            // 客观判定器
//         "cmd": "node",
//         "args": ["--test", "test/x.test.js"],
//         "expectExit": 0,
//         "mustContain": "fail 0",             // 可选：stdout 必须包含
//         "mustNotContain": "..."              // 可选：stdout 不得包含
//       }
//     }
//   ]
// }
//
// 设计要点：verify 必须是「跑一条命令看退出码/输出」这种客观判定，
// 不能出现「人工阅读判断」的环节——否则 A/B 实验的结论无法自动化、无法复现。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TASKS_DIR = path.join(__dirname, 'tasks');

function fail(msg) {
  throw new Error(`任务集校验失败：${msg}`);
}

/** 校验单个任务定义 */
export function validateTask(task, taskSetId) {
  const where = `${taskSetId}/${task?.id ?? '<无 id>'}`;
  if (!task || typeof task !== 'object') fail(`${where} 不是对象`);
  if (!task.id) fail(`${where} 缺少 id`);
  if (!task.prompt) fail(`${where} 缺少 prompt`);
  if (!task.workspace || typeof task.workspace !== 'object' || !Object.keys(task.workspace).length) {
    fail(`${where} 缺少 workspace（初始文件不可为空）`);
  }
  for (const [rel, content] of Object.entries(task.workspace)) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
      fail(`${where} workspace 路径必须相对且不得越界：${rel}`);
    }
    if (typeof content !== 'string') fail(`${where} workspace["${rel}"] 必须是字符串内容`);
  }
  const v = task.verify;
  if (!v || typeof v !== 'object') fail(`${where} 缺少 verify`);
  if (!v.cmd) fail(`${where} verify 缺少 cmd`);
  if (!Array.isArray(v.args)) fail(`${where} verify.args 必须是数组`);
  if (v.expectExit !== undefined && !Number.isInteger(v.expectExit)) {
    fail(`${where} verify.expectExit 必须是整数`);
  }
  // solution 可选：仅 mock 后端使用，代表"做对这道题时工作区应变成什么样"。
  // 真实 Agent 后端忽略它（改动由模型自己产生）。
  if (task.solution !== undefined) {
    if (typeof task.solution !== 'object' || task.solution === null) {
      fail(`${where} solution 必须是对象`);
    }
    for (const [rel, content] of Object.entries(task.solution)) {
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        fail(`${where} solution 路径必须相对且不得越界：${rel}`);
      }
      if (typeof content !== 'string') fail(`${where} solution["${rel}"] 必须是字符串内容`);
    }
  }
  return task;
}

/** 校验并规范化整个任务集 */
export function validateTaskSet(spec, source) {
  if (!spec || typeof spec !== 'object') fail(`${source} 不是对象`);
  if (!spec.id) fail(`${source} 缺少 id`);
  if (!Array.isArray(spec.tasks) || !spec.tasks.length) fail(`${source} 缺少非空的 tasks`);
  const seen = new Set();
  for (const t of spec.tasks) {
    validateTask(t, spec.id);
    if (seen.has(t.id)) fail(`${spec.id} 存在重复任务 id：${t.id}`);
    seen.add(t.id);
  }
  return {
    id: spec.id,
    name: spec.name || spec.id,
    description: spec.description || '',
    verifyTimeoutMs: spec.verifyTimeoutMs ?? 15000,
    source,
    tasks: spec.tasks.map((t) => ({
      ...t,
      skillTags: Array.isArray(t.skillTags) ? t.skillTags : [],
      title: t.title || t.id,
    })),
  };
}

/** 列出内置任务集 id */
export function listTaskSets() {
  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.basename(f, '.json'))
    .sort();
}

/**
 * 加载任务集：既接受内置 id（如 "codegen-basic"），也接受任意 JSON 文件路径。
 */
export function loadTaskSet(idOrPath) {
  if (!idOrPath) {
    const builtin = listTaskSets();
    if (!builtin.length) fail('未找到任何内置任务集');
    return loadTaskSet(builtin[0]);
  }
  const builtinPath = path.join(TASKS_DIR, `${idOrPath}.json`);
  const target = fs.existsSync(builtinPath) ? builtinPath : idOrPath;
  if (!fs.existsSync(target)) {
    throw new Error(`未知任务集 "${idOrPath}"，内置可用：${listTaskSets().join(', ')}`);
  }
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (e) {
    throw new Error(`任务集 ${target} JSON 解析失败：${e.message}`);
  }
  return validateTaskSet(spec, target);
}
