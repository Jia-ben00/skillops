import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function callMcp(lines) {
  const input = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const out = execFileSync(process.execPath, [CLI, 'mcp'], { input, encoding: 'utf8', timeout: 30000 });
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('MCP 握手：initialize + tools/list', () => {
  const resps = callMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  assert.equal(resps[0].result.serverInfo.name, 'skillops');
  assert.ok(resps[0].result.protocolVersion);
  const names = resps[1].result.tools.map((t) => t.name);
  assert.deepEqual(names, ['skillops_doctor', 'skillops_bench', 'skillops_report']);
});

test('MCP tools/call：skillops_doctor 返回体检结果', () => {
  const resps = callMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'skillops_doctor', arguments: { skillsRoot: FIX } } },
  ]);
  const call = resps.find((r) => r.id === 2);
  assert.equal(call.result.isError, false);
  const text = call.result.content[0].text;
  const data = JSON.parse(text);
  assert.equal(data.totals.skillCount, 7);
  assert.ok(data.score > 0);
});

test('MCP tools/call：skillops_bench 返回评测结果', () => {
  const resps = callMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'skillops_bench', arguments: { skillsRoot: FIX, suite: 'codegen' } } },
  ]);
  const call = resps.find((r) => r.id === 2);
  const data = JSON.parse(call.result.content[0].text);
  assert.equal(data.results.length, 7);
});
