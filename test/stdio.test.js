import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('answers JSON-RPC line by line over stdio', async () => {
  const p = spawn(process.execPath, [new URL('../bin/edgepress-mcp.js', import.meta.url).pathname], {
    env: { ...process.env, EDGEPRESS_TENANT: 'example.invalid', EDGEPRESS_TOKEN: 'epat_x' },
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  p.stdin.end('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  await new Promise((r) => p.on('close', r));
  const msgs = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(msgs.map((m) => m.id).sort(), [1, 2]); // notification gets no reply
  assert.deepEqual(msgs.find((m) => m.id === 1).result.tools.map((t) => t.name), ['ep_request', 'ep_api_spec']);
});
