// SkillBench 套件加载器
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUITES_DIR = path.join(__dirname, 'suites');

export function listSuites() {
  return fs
    .readdirSync(SUITES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.basename(f, '.json'));
}

export function loadSuite(id) {
  const p = path.join(SUITES_DIR, `${id}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`未知套件 "${id}"，可用: ${listSuites().join(', ')}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function loadCustomSuite(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
