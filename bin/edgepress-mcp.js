#!/usr/bin/env node
// stdio transport: one JSON-RPC message per line on stdin, one per line on
// stdout. stdout is the protocol channel — anything else goes to stderr.
import { createInterface } from 'node:readline';
import { handleMessage } from '../src/mcp.js';

const tenant = (process.env.EDGEPRESS_TENANT ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const token = process.env.EDGEPRESS_TOKEN ?? '';
if (!tenant || !token) {
  console.error('edgepress-mcp: set EDGEPRESS_TENANT (e.g. blog.edgepress.cc) and EDGEPRESS_TOKEN (epat_...).');
  process.exit(1);
}
const SPEC_URL = process.env.EDGEPRESS_SPEC_URL ?? 'https://api-docs.edgepress.cc/openapi.json';

const host = {
  async api(method, path, body) {
    const r = await fetch(`https://${tenant}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON body: pass through */ }
    return { status: r.status, body: parsed };
  },
  async loadSpec() {
    const r = await fetch(SPEC_URL);
    if (!r.ok) throw new Error(`OpenAPI spec unavailable (HTTP ${r.status})`);
    return r.json();
  },
};

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const res = await handleMessage(msg, host);
  if (res) send(res);
});
