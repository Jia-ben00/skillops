// 生成确定性测试 fixture（bloated-skill：超长描述 + 超长正文 + 内联脚本）
// 用法: node scripts/gen-fixtures.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DESC_BASE =
  '处理大型项目的依赖分析与构建优化，支持多模块工程的依赖图可视化和构建缓存策略推荐，同时覆盖 monorepo 场景下的增量构建与并行任务调度配置。';

function buildBloated() {
  const desc = DESC_BASE.repeat(24); // ≈1752 字符 > 1536
  const lines = ['# bloated-skill', '', '当用户要求分析依赖或优化构建时使用。', ''];
  for (let i = 0; i < 500; i += 1) {
    lines.push(`流程步骤${i + 1}：检查依赖项、生成构建图、输出优化建议。`);
  }
  lines.push('', '```js');
  for (let i = 0; i < 400; i += 1) {
    lines.push('function helper(){ return Math.random(); }');
  }
  lines.push('```', '');
  return `---\nname: bloated-skill\ndescription: ${desc}\n---\n${lines.join('\n')}`;
}

const dir = path.join(ROOT, 'test', 'fixtures', 'bloated-skill');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'SKILL.md'), buildBloated(), 'utf8');
const stat = fs.statSync(path.join(dir, 'SKILL.md'));
console.log(`bloated-skill 已生成: ${stat.size} bytes`);
