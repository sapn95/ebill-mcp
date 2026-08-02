// Minimal MCP client over stdio, so tests drive the server exactly as a real
// client would rather than importing its internals.
//
// Every default here points somewhere that cannot be a bank. EBILL_BASE_URL and
// EBILL_CDP are set by the caller to the fixture and to a throwaway browser;
// EBILL_BANK_URL is blanked, because a variable that is *set* wins even when it
// is empty, and an empty one is how "there is no bank to open" is expressed. A
// test that inherited the developer's real value could open a real login window.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

export async function startServer(env = {}, { timeout = 30000 } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'ebill-test-'));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      EBILL_BASE_URL: 'http://127.0.0.1:1',   // refused, not the real portal
      EBILL_CDP: 'http://127.0.0.1:1',        // refused, not a real browser
      EBILL_BANK_URL: '',                     // set-and-empty: there is no bank here
      EBILL_PROFILE: join(scratch, 'profile'),
      ...env,
    },
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });

  const pending = new Map();
  let id = 1;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    line = line.trim();
    if (!line) return;
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const i = id++;
    pending.set(i, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    // unref: a pending timeout must not hold the test runner's event loop open
    setTimeout(() => reject(new Error(`${method} timed out after ${timeout}ms\n${stderr}`)), timeout).unref();
  });

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    init,
    scratch,
    stderr: () => stderr,
    tools: async () => (await rpc('tools/list', {})).result.tools,
    call: async (name, args = {}) => {
      const m = await rpc('tools/call', { name, arguments: args });
      const raw = m.result?.content?.[0]?.text ?? JSON.stringify(m.error ?? m);
      let data;
      try { data = JSON.parse(raw); } catch { data = null; }
      return { raw, data, isError: !!m.result?.isError || !!m.error };
    },
    // Close stdin and let the server exit on its own. Killed outright it never
    // flushes its V8 coverage, and the whole run then reports 0/0 for a file
    // every test touched — which is how a coverage floor stops meaning
    // anything. The kill is the backstop, not the plan.
    stop() {
      child.stdin.end();
      return new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const t = setTimeout(() => { child.kill(); resolve(); }, 5000);
        t.unref();
        child.once('exit', () => { clearTimeout(t); resolve(); });
      });
    },
  };
}
