// 版本号的唯一来源。
// 全项目（CLI / MCP / Web 服务 / 报告模板）一律从这里读，禁止在任何模块里硬编码版本字符串。
// 这样「改 package.json 版本」就是唯一的版本变更动作，不存在多处漂移的可能。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export default VERSION;
