import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRepoArg,
  searchRepos,
  aggregateSkills,
  discoverSkills,
  downloadSkill,
  sha256,
  subscribe,
  saveSubscriptions,
  loadSubscriptions,
  updateSubscription,
} from '../src/market.js';

/** 内存 mock fetch：按 URL 返回固定内容 */
function makeFetch({ repos, trees, raws }) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/search/repositories')) {
      return new Response(JSON.stringify({ items: repos }));
    }
    if (u.includes('/git/trees/')) {
      return new Response(JSON.stringify({ tree: trees }));
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(u) && !u.includes('/git/') && !u.includes('/contents/')) {
      return new Response(JSON.stringify({ default_branch: 'main' }));
    }
    if (u.includes('/contents/')) {
      const rel = decodeURIComponent(u.split('/contents/')[1]);
      const raw = raws.find((r) => r.url.includes(`/${rel}`));
      if (raw) return new Response(JSON.stringify({ content: Buffer.from(raw.body).toString('base64'), encoding: 'base64' }));
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }
    const raw = raws.find((r) => r.url === u);
    if (raw) return new Response(raw.body);
    return new Response('not found', { status: 404 });
  };
}

const REPOS = [
  { full_name: 'team-a/skill-collection', description: '技能合集', stargazers_count: 42, default_branch: 'main', html_url: 'https://github.com/team-a/skill-collection' },
];
const TREE = [
  { path: 'skills/good-skill/SKILL.md', type: 'blob' },
  { path: 'skills/good-skill/scripts/run.js', type: 'blob' },
  { path: 'skills/frontend-rules/frontend-rules.mdc', type: 'blob' },
  { path: 'README.md', type: 'blob' },
];

test('parseRepoArg 支持 owner/repo 与完整 URL', () => {
  assert.deepEqual(parseRepoArg('team-a/skill-collection'), { owner: 'team-a', repo: 'skill-collection' });
  assert.deepEqual(parseRepoArg('https://github.com/team-a/skill-collection.git'), { owner: 'team-a', repo: 'skill-collection' });
  assert.throws(() => parseRepoArg('nope'));
});

test('searchRepos 解析仓库列表', async () => {
  const fetchImpl = makeFetch({ repos: REPOS });
  const list = await searchRepos(fetchImpl, 'skills', { limit: 1 });
  assert.equal(list.length, 1);
  assert.equal(list[0].fullName, 'team-a/skill-collection');
  assert.equal(list[0].stars, 42);
});

test('aggregateSkills 聚合技能目录（含 .mdc）', () => {
  const skills = aggregateSkills({ tree: TREE });
  assert.equal(skills.length, 2);
  const good = skills.find((s) => s.name === 'good-skill');
  assert.equal(good.root, 'skills/good-skill');
  assert.equal(good.format, 'agent-skill');
  assert.equal(good.files.length, 2);
  const rules = skills.find((s) => s.name === 'frontend-rules');
  assert.equal(rules.format, 'cursor-rule');
  assert.equal(rules.files.length, 1);
});

test('discoverSkills 端到端（meta + tree）', async () => {
  const fetchImpl = makeFetch({ repos: REPOS, trees: TREE });
  const d = await discoverSkills(fetchImpl, 'team-a/skill-collection');
  assert.equal(d.branch, 'main');
  assert.equal(d.skills.length, 2);
});

test('downloadSkill 下载并计算校验和', async () => {
  const body = '---\nname: good-skill\ndescription: demo\n---\n# good\n';
  const fetchImpl = makeFetch({
    repos: REPOS,
    trees: TREE,
    raws: [
      { url: 'https://raw.githubusercontent.com/team-a/skill-collection/main/skills/good-skill/SKILL.md', body },
      { url: 'https://raw.githubusercontent.com/team-a/skill-collection/main/skills/good-skill/scripts/run.js', body: 'console.log(1)' },
    ],
  });
  const d = await discoverSkills(fetchImpl, 'team-a/skill-collection');
  const files = await downloadSkill(fetchImpl, d, 0);
  assert.equal(files.name, 'good-skill');
  assert.equal(files.files.length, 2);
  assert.equal(files.files[0].checksum, sha256(body));
});

let tmp;
test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-market-'));
  // 隔离订阅文件路径，避免污染用户主目录（跨平台设置 HOME/USERPROFILE）
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
});
test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('subscribe 去重 + list 持久化', () => {
  const fetchImpl = makeFetch({ repos: REPOS, trees: TREE });
  const a = subscribe(fetchImpl, 'team-a/skill-collection', { skillIndex: 0, target: path.join(tmp, 'skills') });
  assert.equal(a.added, true);
  const b = subscribe(fetchImpl, 'team-a/skill-collection', { skillIndex: 0, target: path.join(tmp, 'skills') });
  assert.equal(b.added, false);
  assert.equal(loadSubscriptions().length, 1);
});

test('updateSubscription：dry-run 不写盘，--apply 只写差异文件', async () => {
  const skillMd = '---\nname: good-skill\ndescription: demo\n---\n# good\n';
  const runJs = 'console.log("new version")';
  const fetchImpl = makeFetch({
    repos: REPOS,
    trees: TREE,
    raws: [
      { url: 'https://raw.githubusercontent.com/team-a/skill-collection/main/skills/good-skill/SKILL.md', body: skillMd },
      { url: 'https://raw.githubusercontent.com/team-a/skill-collection/main/skills/good-skill/scripts/run.js', body: runJs },
    ],
  });
  const sub = {
    repo: 'team-a/skill-collection',
    skillIndex: 0,
    target: path.join(tmp, 'skills'),
  };
  // 本地已有旧版 run.js
  const dest = path.join(tmp, 'skills', 'good-skill', 'scripts', 'run.js');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'console.log("old")', 'utf8');

  const dry = await updateSubscription(fetchImpl, sub, { apply: false });
  assert.equal(dry.changed.length, 2, 'dry-run 应报告 SKILL.md 新增 + run.js 更新');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'console.log("old")', 'dry-run 不应写盘');

  const applied = await updateSubscription(fetchImpl, sub, { apply: true });
  assert.equal(applied.changed.length, 2);
  assert.equal(fs.readFileSync(dest, 'utf8'), runJs, 'apply 应更新 run.js');
  assert.ok(applied.lastUpdate);
});

test('updateSubscription：无变化时跳过', async () => {
  const skillMd = '---\nname: good-skill\ndescription: demo\n---\n# good\n';
  const fetchImpl = makeFetch({
    repos: REPOS,
    trees: TREE,
    raws: [
      { url: 'https://raw.githubusercontent.com/team-a/skill-collection/main/skills/good-skill/SKILL.md', body: skillMd },
      { url: 'https://raw.githubusercontent.com/team-a/skill-collection/main/skills/good-skill/scripts/run.js', body: 'console.log(1)' },
    ],
  });
  const sub = { repo: 'team-a/skill-collection', skillIndex: 0, target: path.join(tmp, 'skills') };
  // 先全量 apply 一次
  await updateSubscription(fetchImpl, sub, { apply: true });
  const second = await updateSubscription(fetchImpl, sub, { apply: true });
  assert.equal(second.changed.length, 0, '内容一致应无变化');
});
