import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkill } from '../src/skillfile.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('good-skill 解析：frontmatter/描述/税估算', () => {
  const s = parseSkill(path.join(FIX, 'good-skill'));
  assert.equal(s.name, 'good-skill');
  assert.ok(s.hasDescription);
  assert.equal(s.license, 'MIT');
  assert.ok(s.listingTax > 0);
  assert.ok(s.triggerTax > 0);
  assert.ok(s.lines < 500);
});

test('bloated-skill 解析：超长描述与超长正文被正确量化', () => {
  const s = parseSkill(path.join(FIX, 'bloated-skill'));
  assert.ok(s.description.length > 1536, '描述应超 1536 字符');
  assert.ok(s.lines > 500, '行数应超 500');
  assert.ok(s.inlineScriptTokens > 3000, '内联脚本 token 应超 3000');
});

test('无 frontmatter 也能解析（退化场景）', () => {
  const dir = path.join(FIX, 'dup-a');
  const s = parseSkill(dir);
  assert.ok(s.name);
});
