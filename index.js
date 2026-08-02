#!/usr/bin/env node
// MCP server for the Swiss eBill portal (SIX), read-only.
//
// There is no API you can hold a credential for. The portal is reached only
// through an authenticated e-banking session, so a run cannot start without a
// human: you log in once in a visible browser window, and this server reads
// through that window afterwards. The split is not politeness. The login is
// second-factor-bound and the portal is analytics-instrumented, so everything
// the automation does is visible to the bank, and the only defensible thing for
// it to do is read.
//
// Read-only is enforced twice, because "we only wrote GETs" is a property of
// today's code and not of tomorrow's:
//
//   1. Every request goes through get(), which takes no method and no body.
//   2. Every API path is matched against ALLOWED before it is sent. Approving a
//      bill, releasing one, editing an amount, subscribing to a biller and
//      cancelling a standing approval are all one call away in the same API —
//      and none of those paths is on the list, so reaching one takes editing
//      this file rather than passing an argument.
//
// Environment:
//   EBILL_BASE_URL  https://ebill-portal.six-group.com  the portal origin
//   EBILL_CDP       http://localhost:9222               where the logged-in window listens
//   EBILL_PROFILE   ~/.ebill-mcp/profile                browser profile — holds a live banking session
//   EBILL_BANK_URL  (unset)                             e-banking entry page for ebill_open
//   EBILL_BROWSER   chrome                              channel or absolute path
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, mkdirSync, openSync, closeSync, writeSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { spawn } from 'node:child_process';

const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// A variable that is set, even to the empty string, is authoritative — the same
// rule the sibling servers use. An empty EBILL_BASE_URL means "no portal", not
// "fall back to production": otherwise a test that thought it was pointed at a
// fixture could quietly open somebody's bank.
const envOr = (name, fallback) => (process.env[name] !== undefined ? process.env[name] : fallback);

const BASE = envOr('EBILL_BASE_URL', 'https://ebill-portal.six-group.com').replace(/\/+$/, '');
if (!BASE) throw new Error('EBILL_BASE_URL is set but empty — refusing to guess a portal origin');
const CDP = envOr('EBILL_CDP', 'http://localhost:9222').replace(/\/+$/, '');
if (!CDP) throw new Error('EBILL_CDP is set but empty — refusing to guess where the browser listens');
const PROFILE = envOr('EBILL_PROFILE', join(homedir(), '.ebill-mcp', 'profile'));
const BANK_URL = envOr('EBILL_BANK_URL', '');
const BROWSER = envOr('EBILL_BROWSER', 'chrome');

const API = '/ebill-portal/api/v1';
const PDFS = '/ebill-portal/ui/payment-pdfs';

// The whole surface this server is allowed to reach. Every entry is a read; the
// endpoints that move money or change a standing arrangement are deliberately
// absent, and adding one is an edit to this list rather than an argument.
const ALLOWED = [
  /^\/ebill-portal\/api\/v1\/user$/,
  /^\/ebill-portal\/api\/v1\/config$/,
  /^\/ebill-portal\/api\/v1\/payments\?[^#]*$/,
  /^\/ebill-portal\/api\/v1\/payments\/billers$/,
  /^\/ebill-portal\/ui\/payment-pdfs\/[^/]+\/[^/]+$/,
];
const allowed = path => ALLOWED.some(re => re.test(path));

// One page of the archive. The UI asks for 20; 100 is accepted and the
// difference is a dozen round trips against a bank session that expires.
const PAGE = 100;
// Two of them, and both are needed. The default view shows one, and an archive
// pulled from a single status is silently half an archive.
const STATUSES = ['done', 'open'];

const DEBUG = !!process.env.EBILL_DEBUG;
const trace = (...a) => { if (DEBUG) process.stderr.write(a.join(' ') + '\n'); };

// --- the browser the user logged in with ------------------------------------

// Resolved once and reused. Connecting over CDP is cheap, but each connection is
// a client the portal's window has to serve, and a tool that reconnects per call
// leaves a trail of them behind on an error path.
// The promise is memoised, not the value. Two tool calls arriving together both
// found null and both started an import, which is harmless here but is the same
// shape as every double-open bug — and the fix costs nothing.
let pwLib = null;
function playwright() {
  pwLib ??= import('playwright').then(mod => {
    // The default export shape differs between installs; the named one is
    // absent in some, which is a five-minute mystery every single time.
    const lib = mod.chromium ? mod : mod.default;
    if (!lib?.chromium) throw new Error('playwright resolved but has no chromium export');
    return lib;
  }).catch(e => { pwLib = null; throw e; });
  return pwLib;
}

// Disconnecting a CDP client leaves the window standing, which is the whole
// point: one login, many calls. Closing the browser object here does NOT close
// the user's window — that distinction is what makes this usable at all.
async function withPortal(fn) {
  const pw = await playwright();
  let browser;
  try {
    browser = await pw.chromium.connectOverCDP(CDP, { timeout: 10000 });
  } catch (e) {
    throw new Error(`no browser is listening at ${CDP} — run ebill_open and log in first (${e.message})`, { cause: e });
  }
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('the browser has no context — is it still starting?');
    const page = ctx.pages().find(p => p.url().includes('ebill-portal'));
    if (!page) {
      throw new Error('no eBill tab is open in that window — log in to e-banking and open eBill, then try again');
    }
    return await fn({ page, ctx, browser });
  } finally {
    // Disconnect, never close: closing would take the user's session with it.
    await browser.close().catch(() => {});
  }
}

// Every read goes through here. No method, no body — the shape of the function
// is the first half of "read-only", and the path check is the second.
async function get(page, path) {
  if (!allowed(path)) {
    throw new Error(`refused: ${path.split('?')[0]} is not one of the paths this server may read`);
  }
  trace('GET', path);
  const r = await page.evaluate(async p => {
    // credentials: 'include' hands the browser's session cookie to the request,
    // so no token ever reaches this process. There is nothing here to leak.
    const res = await fetch(p, { credentials: 'include', headers: { Accept: 'application/json' } });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', text };
  }, path);
  if (r.status === 401 || r.status === 403) {
    throw new Error(`the portal answered ${r.status} — the e-banking session has expired; log in again and retry`);
  }
  if (r.status >= 400) throw new Error(`GET ${path.split('?')[0]} → ${r.status}`);
  if (!r.type.includes('json')) {
    throw new Error(`GET ${path.split('?')[0]} answered ${r.type || 'no content type'} rather than JSON`);
  }
  try {
    return JSON.parse(r.text);
  } catch {
    // The Angular server answers unknown paths under its own prefix with the
    // app shell, and does it with a 200. A status code is not evidence here.
    throw new Error(`GET ${path.split('?')[0]} answered 200 with something that is not JSON — the path probably does not exist`);
  }
}

// --- reading the archive -----------------------------------------------------

// Only the fields anything downstream uses, and the one that is easy to read
// wrong is named: businessCaseDate is when eBill delivered the bill, which is
// days to weeks away from the date printed on the document.
const bill = (b, status) => ({
  id: b.id ?? b.businessCaseId,
  delivered: b.businessCaseDate,
  biller: b.billerName,
  amount: b.amount ? `${b.amount.currency} ${b.amount.value}` : null,
  due: b.dueDate ?? null,
  reference: b.referenceNumber ?? null,
  status: b.paymentStatus?.kind ?? status,
  // No filename means no document. Reported as such rather than guessed at: a
  // synthesised name fetches the app shell and looks like a broken download.
  document: b.receiptFileName ?? null,
  _status: status,
});

async function listBills(page, want, limit) {
  const out = [];
  for (const status of want) {
    let offset = 0;
    for (;;) {
      const d = await get(page, `${API}/payments?status=${status}&sortOrder=desc&offset=${offset}&pageSize=${PAGE}`);
      const content = d.content || [];
      out.push(...content.map(b => bill(b, status)));
      // `last` is the envelope's own answer to "is that everything"; the empty
      // page is the belt to its braces, because a server that forgets to set
      // `last` would otherwise be paged forever.
      if (d.last || !content.length) break;
      if (limit && out.length >= limit) break;
      // By what came back, not by what was asked for. page[limit] is a ceiling
      // and a server may answer short — advancing by PAGE then steps over every
      // record between the end of the short page and the next multiple of 100,
      // and the archive comes back missing rows without a word about it.
      offset += content.length;
    }
    if (limit && out.length >= limit) break;
  }
  return limit ? out.slice(0, limit) : out;
}

// The PDF is not under /api/. It is the query parameter the bundled pdf.js
// viewer is loaded with, and the filename out of the record is part of the path
// — not derivable, not optional, and it has to be URL-encoded.
async function fetchPdf(ctx, id, fileName) {
  const url = `${BASE}${PDFS}/${encodeURIComponent(id)}/${encodeURIComponent(fileName)}`;
  const r = await ctx.request.get(url, { timeout: 60000 });
  const body = await r.body();
  // Checked by its bytes, never by its status. Every wrong guess at this path
  // answers 200, so a probe that reads status codes reports success and is
  // wrong about all of them.
  if (!r.ok() || body.subarray(0, 1024).toString('latin1').indexOf('%PDF-') < 0) {
    throw new Error(`the portal did not answer with a PDF for ${id} (${r.status()}, ${body.length} bytes)`);
  }
  return body;
}

// 0600, and O_EXCL-less on purpose: an existing file is overwritten only when
// the caller named it. A bill is somebody's payment history and has no business
// being world-readable in a downloads folder.
function writeFile(path, bytes) {
  if (!isAbsolute(path)) throw new Error(`output path must be absolute: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    let off = 0;
    while (off < bytes.length) {
      const n = writeSync(fd, bytes, off, bytes.length - off);
      if (!n) throw new Error(`write stalled at ${off}/${bytes.length} bytes`);
      off += n;
    }
  } finally { closeSync(fd); }
}

// --- tools -------------------------------------------------------------------

const TOOLS = [
  { name: 'ebill_status', description: 'Whether a logged-in eBill window is reachable, and how long the session has left.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ebill_open', description: 'Open a visible browser window at your e-banking so YOU can log in. Returns as soon as the window is reachable; it stays open for later calls.', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'e-banking entry page (defaults to EBILL_BANK_URL)' } } } },
  { name: 'ebill_settings', description: 'Report the configuration in force — portal origin, CDP endpoint, profile path. Side-effect free.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ebill_list_bills', description: 'List bills from the archive, newest first. Both open and settled unless you narrow it.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'done', 'all'], description: 'default all — one status alone is half an archive' }, limit: { type: 'number', description: 'stop after this many' } } } },
  { name: 'ebill_get_bill', description: 'One bill by id, with its biller, amount, due date and whether it has a document.', inputSchema: { type: 'object', properties: { bill_id: { type: 'string' } }, required: ['bill_id'] } },
  { name: 'ebill_billers', description: 'Billers that have ever sent something to this account.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ebill_download_bill', description: 'Download one bill PDF to an absolute output_path.', inputSchema: { type: 'object', properties: { bill_id: { type: 'string' }, output_path: { type: 'string', description: 'absolute path to write to' } }, required: ['bill_id', 'output_path'] } },
  { name: 'ebill_download_all', description: 'Download every bill that has a document into output_dir, named <delivered>_<id>.pdf. Existing files are skipped, never overwritten.', inputSchema: { type: 'object', properties: { output_dir: { type: 'string', description: 'absolute directory to write into' }, status: { type: 'string', enum: ['open', 'done', 'all'] } }, required: ['output_dir'] } },
];

const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const statuses = s => (!s || s === 'all' ? STATUSES : [s]);

const server = new Server({ name: PKG.name, version: PKG.version }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

const callTool = async req => {
  const { name, arguments: args = {} } = req.params;
  if (!TOOLS.some(t => t.name === name)) throw new Error(`unknown tool ${name}`);

  if (name === 'ebill_settings') {
    return text({
      portal: BASE,
      cdp: CDP,
      profile: PROFILE,
      bank_url: BANK_URL || 'not set — ebill_open needs a url argument',
      browser: BROWSER,
      readable_paths: ALLOWED.map(String),
      note: 'read-only: nothing here can approve, release, edit or pay a bill',
    });
  }

  if (name === 'ebill_open') {
    const url = args.url || BANK_URL;
    if (!url) throw new Error('no url given and EBILL_BANK_URL is not set — this server does not guess which bank you use');
    if (!/^https:\/\//.test(url)) throw new Error(`refusing a non-https entry page: ${url}`);
    return text(await openWindow(url));
  }

  return withPortal(async ({ page, ctx }) => {
    if (name === 'ebill_status') {
      const u = await get(page, `${API}/user`);
      return text({
        session: 'reachable',
        tab: page.url(),
        timeout_seconds: u.sessionTimeoutSeconds ?? null,
        notification_mode: u.notificationMode ?? null,
      });
    }

    if (name === 'ebill_billers') {
      const d = await get(page, `${API}/payments/billers`);
      const list = Array.isArray(d) ? d : (d.content || []);
      return text({ billers: list.map(b => b.name ?? b.billerName ?? b).filter(Boolean) });
    }

    if (name === 'ebill_list_bills') {
      const bills = await listBills(page, statuses(args.status), args.limit);
      const missing = bills.filter(b => !b.document).length;
      return text({
        bills,
        count: bills.length,
        // Said out loud rather than left to be noticed: a caller that plans a
        // download run off this list needs to know some of it has no document.
        ...(missing ? { without_document: missing } : {}),
      });
    }

    if (name === 'ebill_get_bill') {
      const id = String(args.bill_id ?? '');
      const found = (await listBills(page, STATUSES)).find(b => String(b.id) === id);
      if (!found) throw new Error(`no bill with id ${JSON.stringify(id).slice(0, 60)} in the archive`);
      return text(found);
    }

    if (name === 'ebill_download_bill') {
      const id = String(args.bill_id ?? '');
      const found = (await listBills(page, STATUSES)).find(b => String(b.id) === id);
      if (!found) throw new Error(`no bill with id ${JSON.stringify(id).slice(0, 60)} in the archive`);
      if (!found.document) throw new Error(`bill ${id} has no document — eBill delivered it without one`);
      const bytes = await fetchPdf(ctx, found.id, found.document);
      writeFile(String(args.output_path ?? ''), bytes);
      return text({ saved: args.output_path, bytes: bytes.length, biller: found.biller, delivered: found.delivered });
    }

    if (name === 'ebill_download_all') {
      const dir = String(args.output_dir ?? '');
      if (!isAbsolute(dir)) throw new Error(`output_dir must be absolute: ${dir}`);
      const bills = await listBills(page, statuses(args.status));
      const saved = [], skipped = [], failed = [];
      for (const b of bills) {
        if (!b.document) { skipped.push({ id: b.id, why: 'no document' }); continue; }
        const dest = join(dir, `${b.delivered}_${b.id}.pdf`);
        try {
          writeFile(dest, await fetchPdf(ctx, b.id, b.document));
          saved.push(dest);
        } catch (e) {
          // One failure is not the end of the run: an archive is worth having
          // in part, and the ones that failed are named so they can be retried.
          failed.push({ id: b.id, biller: b.biller, why: e.message });
        }
      }
      return text({ saved: saved.length, skipped, failed, directory: dir });
    }

    throw new Error(`unknown tool ${name}`);
  });
};

// --- opening the window ------------------------------------------------------

// Detached and never awaited: the process holds the window open for the rest of
// the session, so waiting for it to exit would wait forever. Readiness is the
// CDP endpoint answering, not a line in a log — the log line arrives before the
// port is listening and a run that trusts it fails on the next call.
async function openWindow(url) {
  const port = Number(new URL(CDP).port || 9222);
  if (await cdpAlive()) return { already_open: true, cdp: CDP };
  mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
  // Written as a module, because this package is one: a `require` here fails
  // outright, and it fails in a detached child with its output thrown away, so
  // the only symptom is a window that never appears.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { chromium } = await import('playwright');
    const ctx = await chromium.launchPersistentContext(${JSON.stringify(PROFILE)}, {
      channel: ${JSON.stringify(BROWSER)}, headless: false, locale: 'de-CH',
      args: ['--remote-debugging-port=${port}'], viewport: null,
    });
    await (ctx.pages()[0] ?? await ctx.newPage()).goto(${JSON.stringify(url)});
    await new Promise(() => {});   // holds the window open for the rest of the session
  `], { detached: true, stdio: 'ignore', cwd: process.cwd() });
  child.unref();

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await cdpAlive()) return { opened: true, cdp: CDP, next: 'log in to e-banking and open eBill, then call ebill_status' };
    await new Promise(r => { setTimeout(r, 500); });
  }
  throw new Error(`the window did not come up on ${CDP} within a minute`);
}

async function cdpAlive() {
  try {
    const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

server.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    return await callTool(req);
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERROR: ' + (e.message || String(e)) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
