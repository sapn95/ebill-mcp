// Drives every tool over stdio against the local fixture, through a real
// Chromium attached over CDP — which is the whole program: this server does not
// launch the browser it reads through, it attaches to the one a human logged in
// with. No test here may reach a bank: EBILL_BASE_URL points at 127.0.0.1,
// EBILL_CDP at a throwaway browser, and EBILL_BANK_URL is set to empty.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, PDF_BYTES } from './mock-ebill.mjs';
import { startBrowser } from './browser.mjs';
import { startServer } from './client.mjs';

let mock, win, srv, out;

before(async () => {
  mock = await start();
  win = await startBrowser(mock.page);
  out = mkdtempSync(join(tmpdir(), 'ebill-out-'));
  srv = await startServer({ EBILL_BASE_URL: mock.base, EBILL_CDP: win.cdp });
});

after(async () => {
  await srv?.stop();
  await win?.close();
  await mock?.close();
});

describe('protocol', () => {
  test('advertises itself with the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(srv.init.result.serverInfo.name, pkg.name);
    assert.equal(srv.init.result.serverInfo.version, pkg.version);
  });

  test('every tool is declared with an object schema whose required fields exist', async () => {
    const tools = await srv.tools();
    assert.equal(tools.length, 8, `expected the full tool set, got ${tools.map(t => t.name)}`);
    for (const t of tools) {
      assert.ok(t.description.length > 20, `${t.name}: description too thin`);
      assert.equal(t.inputSchema.type, 'object', `${t.name}: schema is not an object`);
      for (const r of t.inputSchema.required || []) {
        assert.ok(Object.hasOwn(t.inputSchema.properties, r), `${t.name}: required "${r}" undeclared`);
      }
    }
  });

  test('an unknown tool is an error rather than a silent no-op', async () => {
    const { raw, isError } = await srv.call('ebill_pay_everything');
    assert.ok(isError);
    assert.match(raw, /unknown tool/);
  });
});

describe('reading the archive', () => {
  test('reports the session and how long it has left', async () => {
    const { data } = await srv.call('ebill_status');
    assert.equal(data.session, 'reachable');
    assert.equal(data.timeout_seconds, 900);
    assert.match(data.tab, /ebill-portal/);
  });

  test('lists both statuses, because one alone is half an archive', async () => {
    const { data } = await srv.call('ebill_list_bills');
    assert.equal(data.count, 3, JSON.stringify(data.bills));
    const asked = mock.state.calls.filter(c => c.includes('/payments?'));
    assert.ok(asked.some(c => c.includes('status=done')), `never asked for done: ${asked}`);
    assert.ok(asked.some(c => c.includes('status=open')), `never asked for open: ${asked}`);
  });

  test('a bill carries the delivery date, the biller and the amount', async () => {
    const { data } = await srv.call('ebill_list_bills', { status: 'open' });
    assert.equal(data.count, 1);
    const b = data.bills[0];
    assert.equal(b.id, 'bc-002');
    assert.equal(b.delivered, '2026-07-11');
    assert.equal(b.amount, 'CHF 59.9');
    assert.equal(b.due, '2026-08-01');
  });

  test('a bill with no document says so instead of leaving it to be discovered', async () => {
    const { data } = await srv.call('ebill_list_bills');
    const none = data.bills.find(b => b.id === 'bc-003');
    assert.equal(none.document, null);
    // Announced on the list itself: a caller planning a download run off this
    // answer would otherwise find out one at a time, from failures.
    assert.equal(data.without_document, 1, JSON.stringify(data));
  });

  test('the page size asked for is the large one, not the twenty the UI uses', async () => {
    await srv.call('ebill_list_bills');
    const asked = mock.state.calls.filter(c => c.includes('/payments?')).at(-1);
    assert.match(asked, /pageSize=100/, asked);
  });

  test('an archive longer than one page is read to the end', async () => {
    mock.state.pageOverride = 1;      // one record per page, three records
    try {
      const { data } = await srv.call('ebill_list_bills');
      assert.equal(data.count, 3, 'stopped at the first page');
    } finally {
      mock.state.pageOverride = null;
    }
  });

  test('a limit stops the paging rather than only trimming the answer', async () => {
    mock.state.pageOverride = 1;
    const before = mock.state.calls.length;
    try {
      const { data } = await srv.call('ebill_list_bills', { limit: 1 });
      assert.equal(data.count, 1);
      const pages = mock.state.calls.slice(before).filter(c => c.includes('/payments?')).length;
      assert.equal(pages, 1, `asked for ${pages} pages to return one record`);
    } finally {
      mock.state.pageOverride = null;
    }
  });

  test('one bill by id, and an id that is not in the archive says so', async () => {
    const { data } = await srv.call('ebill_get_bill', { bill_id: 'bc-001' });
    assert.equal(data.biller, 'Example Energie AG');
    const miss = await srv.call('ebill_get_bill', { bill_id: 'bc-999' });
    assert.ok(miss.isError);
    assert.match(miss.raw, /no bill with id/);
  });

  test('names the billers', async () => {
    const { data } = await srv.call('ebill_billers');
    assert.ok(data.billers.includes('Example Telecom'), JSON.stringify(data));
  });
});

describe('downloads', () => {
  test('saves the PDF the record names, not one it made up', async () => {
    const dest = join(out, 'one.pdf');
    const { data } = await srv.call('ebill_download_bill', { bill_id: 'bc-001', output_path: dest });
    assert.equal(data.bytes, PDF_BYTES.length);
    assert.equal(readFileSync(dest, 'latin1'), PDF_BYTES);
    // The filename is part of the path and is not derivable from the id, so the
    // request has to carry the encoded one out of the record.
    const asked = mock.state.calls.filter(c => c.includes('payment-pdfs')).at(-1);
    assert.match(asked, /Rechnung(%20| )Juli\.pdf/, asked);
  });

  test('a saved bill is not readable by everyone else on the machine', async () => {
    const dest = join(out, 'perm.pdf');
    await srv.call('ebill_download_bill', { bill_id: 'bc-001', output_path: dest });
    assert.equal(statSync(dest).mode & 0o077, 0, 'a bill is somebody payment history');
  });

  test('a relative output_path is refused rather than resolved against a directory nobody chose', async () => {
    const { raw, isError } = await srv.call('ebill_download_bill', { bill_id: 'bc-001', output_path: 'bill.pdf' });
    assert.ok(isError);
    assert.match(raw, /absolute/);
  });

  test('a bill with no document is refused before anything is fetched', async () => {
    const { raw, isError } = await srv.call('ebill_download_bill', { bill_id: 'bc-003', output_path: join(out, 'x.pdf') });
    assert.ok(isError);
    assert.match(raw, /no document/);
    assert.ok(!existsSync(join(out, 'x.pdf')), 'wrote a file for a bill that has none');
  });

  test('an answer that is not a PDF is refused however healthy its status', async () => {
    // The portal answers every unknown path with 200 and the app shell, so a
    // download that trusted the status code would write the shell to disk and
    // call it an invoice.
    mock.state.pdfBody = '{"app":"ebill-portal"}';
    mock.state.pdfType = 'application/json';
    const dest = join(out, 'shell.pdf');
    try {
      const { raw, isError } = await srv.call('ebill_download_bill', { bill_id: 'bc-001', output_path: dest });
      assert.ok(isError, 'the app shell was accepted as a bill');
      assert.match(raw, /did not answer with a PDF/);
      assert.ok(!existsSync(dest), 'wrote the shell to disk');
    } finally {
      mock.state.pdfBody = PDF_BYTES;
      mock.state.pdfType = 'application/pdf';
    }
  });

  test('download_all saves what it can and names what it could not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebill-all-'));
    const { data } = await srv.call('ebill_download_all', { output_dir: dir });
    assert.equal(data.saved, 2, JSON.stringify(data));
    assert.equal(data.skipped.length, 1, 'the documentless bill was not reported');
    assert.equal(data.skipped[0].id, 'bc-003');
    const written = readdirSync(dir).sort();
    assert.deepEqual(written, ['2026-07-04_bc-001.pdf', '2026-07-11_bc-002.pdf']);
  });

  test('one failure does not end the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebill-part-'));
    // The first bill's document goes missing; the second one still has to land.
    mock.state.pdfMissingFor = 'bc-001';
    try {
      const { data } = await srv.call('ebill_download_all', { output_dir: dir });
      assert.equal(data.saved, 1, JSON.stringify(data));
      assert.equal(data.failed.length, 1);
      assert.equal(data.failed[0].id, 'bc-001');
      assert.ok(data.failed[0].why, 'a failure with no reason is not a report');
    } finally {
      mock.state.pdfMissingFor = null;
    }
  });
});
