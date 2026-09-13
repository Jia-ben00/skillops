import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initTeamRepo, pushSkills, buildRegistry, gateSkills, pullSkills, compareVersions } from '../src/sync.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
let tmp;
test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-sync-'));
});
test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('compareVersions 语义比较', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 'equal');
  assert.equal(compareVersions('0.2.0', '0.1.0'), 'ahead');
  assert.equal(compareVersions('0.1.0', '0.2.0'), 'stale');
  assert.equal(compareVersions('abc', 'abc'), 'equal');
  assert.equal(compareVersions('abc', 'def'), 'different');
});

test('sync init 创建团队仓库布局', () => {
  const repo = path.join(tmp, 'team');
  const created = initTeamRepo(repo);
  assert.ok(fs.existsSync(path.join(repo, 'skills')));
  assert.ok(fs.existsSync(path.join(repo, '.skillops', 'registry.json')));
  assert.ok(fs.existsSync(path.join(repo, '.skillopsignore')));
  assert.ok(created.length >= 2);
});

test('sync push 默认 dry-run 不落盘', () => {
  const repo = path.join(tmp, 'team-dry');
  initTeamRepo(repo);
  const { changed, registryWritten } = pushSkills(repo, FIX);
  assert.equal(registryWritten, false);
  assert.ok(changed.length > 0);
  assert.equal(fs.readdirSync(path.join(repo, 'skills')).length, 0, 'dry-run 不应写入 skills/');
});

test('sync push --apply 拷贝技能并更新 registry', () => {
  const repo = path.join(tmp, 'team-applied');
  initTeamRepo(repo);
  const { changed, registryWritten } = pushSkills(repo, FIX, { apply: true });
  assert.equal(registryWritten, true);
  assert.equal(changed.length, 7);
  const reg = JSON.parse(fs.readFileSync(path.join(repo, '.skillops', 'registry.json'), 'utf8'));
  assert.equal(Object.keys(reg.skills).length, 7);
  assert.ok(reg.skills['good-skill'], 'registry 应含 good-skill');
});

test('sync gate：与团队一致时通过', () => {
  const repo = path.join(tmp, 'team-gate-ok');
  initTeamRepo(repo);
  pushSkills(repo, FIX, { apply: true });
  const { results, passed } = gateSkills(repo, FIX);
  assert.equal(passed, true);
  assert.ok(results.every((r) => r.level !== 'error'));
});

test('sync gate：本地版本落后时门禁失败', () => {
  const repo = path.join(tmp, 'team-gate-stale');
  initTeamRepo(repo);
  pushSkills(repo, FIX, { apply: true });
  // 本地把版本号改旧，制造版本落后
  const local = path.join(tmp, 'local-stale');
  fs.cpSync(FIX, local, { recursive: true });
  const skillMd = path.join(local, 'good-skill', 'SKILL.md');
  let content = fs.readFileSync(skillMd, 'utf8');
  content = content.replace(/^version: .*$/m, 'version: 0.0.9');
  fs.writeFileSync(skillMd, content, 'utf8');
  const { results, passed } = gateSkills(repo, local);
  assert.equal(passed, false);
  const stale = results.find((r) => r.name === 'good-skill');
  assert.ok(stale && stale.status === 'stale');
});

test('sync pull --apply 拉取到本地', () => {
  const repo = path.join(tmp, 'team-pull');
  initTeamRepo(repo);
  pushSkills(repo, FIX, { apply: true });
  const target = path.join(tmp, 'local-pull');
  const { changed } = pullSkills(repo, target, { apply: true });
  assert.equal(changed.length, 7);
  assert.ok(fs.existsSync(path.join(target, 'good-skill', 'SKILL.md')));
});

test('buildRegistry 幂等', () => {
  const repo = path.join(tmp, 'team-rebuild');
  initTeamRepo(repo);
  pushSkills(repo, FIX, { apply: true });
  const reg = buildRegistry(repo);
  assert.equal(Object.keys(reg.skills).length, 7);
});

test('sync gate --strict：未收录技能计为错误', () => {
  const repo = path.join(tmp, 'team-strict');
  initTeamRepo(repo);
  pushSkills(repo, FIX, { apply: true });
  // 本地多出一个 registry 没有的技能
  const local = path.join(tmp, 'local-strict');
  fs.cpSync(FIX, local, { recursive: true });
  fs.mkdirSync(path.join(local, 'brand-new'), { recursive: true });
  fs.writeFileSync(
    path.join(local, 'brand-new', 'SKILL.md'),
    '---\nname: brand-new\ndescription: 一个新技能，尚未收录\n---\n# brand-new\n',
    'utf8',
  );
  const loose = gateSkills(repo, local);
  assert.equal(loose.passed, true, '非 strict 下未收录应为 info');
  const strictRes = gateSkills(repo, local, { strict: true });
  assert.equal(strictRes.passed, false, 'strict 下未收录应为 error');
  assert.ok(strictRes.results.some((r) => r.name === 'brand-new' && r.status === 'unregistered' && r.level === 'error'));
});
