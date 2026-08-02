// A stand-in for the SIX eBill portal, so the whole server can be exercised
// without a bank session and without anybody's payment history on disk.
//
// It speaks the shapes the real portal returns: the paged `{offset, last,
// totalElements, content}` envelope, the PDF served from under /ui/ rather than
// /api/, and — the one that matters most — the trap. The Angular server answers
// any unknown path under its own prefix with the app shell and a 200, so a
// probe that reads status codes reports four working PDF endpoints and is wrong
// about all four. A fixture that 404s those would make the guard that catches
// it untestable, so this one answers exactly as the real portal does.
import { createServer } from 'node:http';

export const PDF_BYTES = '%PDF-1.7 fixture-bill\n%%EOF\n';

// Names and amounts are invented. A fixture that carried a real biller and a
// real reference number would be the thing the hygiene scan exists to catch.
const bills = [
  { id: 'bc-001', businessCaseId: 'bc-001', businessCaseDate: '2026-07-04', billerName: 'Example Energie AG',
    referenceNumber: '00 00000 00000 00000 00000 00001', amount: { currency: 'CHF', value: 142.55 },
    dueDate: '2026-07-25', receiptFileName: 'Rechnung Juli.pdf', paymentStatus: { kind: 'PAID' }, _s: 'done' },
  { id: 'bc-002', businessCaseId: 'bc-002', businessCaseDate: '2026-07-11', billerName: 'Example Telecom',
    referenceNumber: '00 00000 00000 00000 00000 00002', amount: { currency: 'CHF', value: 59.9 },
    dueDate: '2026-08-01', receiptFileName: 'invoice_2026_07.pdf', paymentStatus: { kind: 'OPEN' }, _s: 'open' },
  // No receiptFileName: eBill delivers some bills without a document at all, and
  // a server that synthesises a name fetches the app shell and calls it a
  // broken download instead of saying there was nothing to fetch.
  { id: 'bc-003', businessCaseId: 'bc-003', businessCaseDate: '2026-06-28', billerName: 'Example Versicherung',
    referenceNumber: '00 00000 00000 00000 00000 00003', amount: { currency: 'CHF', value: 1200 },
    dueDate: '2026-07-15', receiptFileName: null, paymentStatus: { kind: 'PAID' }, _s: 'done' },
];

export function start() {
  const state = {
    calls: [],              // "METHOD /path" in order, query included
    bills: bills.map(b => ({ ...b })),
    // Flip to make the archive long enough that one page is not all of it.
    pageOverride: null,
    sessionExpired: false,  // answer 401, the way a timed-out banking session does
    // Make the document for one bill go missing without touching the record.
    // Changing receiptFileName instead would be no sabotage at all: this route
    // reads the expected name out of the same record, so both ends move
    // together and the fetch succeeds — which is exactly how the first attempt
    // at that test passed while proving nothing.
    pdfMissingFor: null,
    pdfBody: PDF_BYTES,
    pdfType: 'application/pdf',
  };

  const send = (res, code, body, type = 'application/json') => {
    const b = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(b) });
    res.end(b);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    state.calls.push(`${req.method} ${req.url}`);

    // Nothing here answers anything but GET, and a fixture that quietly took a
    // POST would let a server that had learned to send one look correct.
    if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });

    if (state.sessionExpired && p.startsWith('/ebill-portal/api/')) {
      return send(res, 401, { error: 'session_expired' });
    }

    if (p === '/ebill-portal/api/v1/user') {
      return send(res, 200, { sessionTimeoutSeconds: 900, notificationMode: 'EMAIL' });
    }
    if (p === '/ebill-portal/api/v1/config') {
      return send(res, 200, { features: { sharing: true }, bankHolidays: [] });
    }
    if (p === '/ebill-portal/api/v1/payments/billers') {
      return send(res, 200, [...new Set(state.bills.map(b => b.billerName))].map(name => ({ name })));
    }
    if (p === '/ebill-portal/api/v1/payments') {
      const status = url.searchParams.get('status');
      const size = state.pageOverride ?? Number(url.searchParams.get('pageSize') || 20);
      const offset = Number(url.searchParams.get('offset') || 0);
      const all = state.bills.filter(b => b._s === status);
      const content = all.slice(offset, offset + size);
      return send(res, 200, {
        offset,
        last: offset + content.length >= all.length,
        totalElements: all.length,
        content,
      });
    }

    const pdf = /^\/ebill-portal\/ui\/payment-pdfs\/([^/]+)\/(.+)$/.exec(p);
    if (pdf) {
      const b = state.bills.find(x => x.id === decodeURIComponent(pdf[1]));
      const want = state.pdfMissingFor === pdf[1] ? null : b?.receiptFileName;
      if (!want || decodeURIComponent(pdf[2]) !== want) {
        // Even this is the app shell rather than a 404 — a wrong filename is an
        // unknown path like any other, and that is exactly why the download has
        // to read the first bytes instead of the status.
        return send(res, 200, { app: 'ebill-portal', shell: true });
      }
      return send(res, 200, Buffer.from(state.pdfBody), state.pdfType);
    }

    // A UI route is a document, because that is what the automation attaches to:
    // the tab has to be a page it can run a fetch from, and a JSON body is not.
    if (p.startsWith('/ebill-portal/ui/')) {
      return send(res, 200, '<!doctype html><title>eBill</title><body>fixture</body>', 'text/html; charset=utf-8');
    }
    // The trap, and the reason this fixture exists at all: everything else under
    // the app's prefix is 200 + the shell, never a 404.
    if (p.startsWith('/ebill-portal/')) return send(res, 200, { app: 'ebill-portal', shell: true });
    return send(res, 404, { error: 'not_found' });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state,
        base: `http://127.0.0.1:${port}`,
        page: `http://127.0.0.1:${port}/ebill-portal/ui/payments/completed`,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}
