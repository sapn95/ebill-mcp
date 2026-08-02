// The tests that exist because of what this server is attached to.
//
// It reads through a live e-banking session. Approving a bill, releasing one,
// editing an amount, cancelling a standing approval and subscribing to a biller
// are all one call away in the same API and the same DOM. "We only wrote GETs"
// is a property of today's code; these are the assertions that make it a
// property of the program.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './mock-ebill.mjs';
import { startBrowser } from './browser.mjs';
import { startServer } from './client.mjs';

let mock, win, srv;

before(async () => {
  mock = await start();
  win = await startBrowser(mock.page);
  srv = await startServer({ EBILL_BASE_URL: mock.base, EBILL_CDP: win.cdp });
});

after(async () => {
  await srv?.stop();
  await win?.close();
  await mock?.close();
});

describe('it cannot move money', () => {
  test('every request the portal ever sees is a GET', async () => {
    // Drive everything that talks to the portal, then look at what arrived.
    // A single POST from any of them is the failure this file is about.
    for (const [name, args] of [
      ['ebill_status', {}],
      ['ebill_list_bills', {}],
      ['ebill_get_bill', { bill_id: 'bc-001' }],
      ['ebill_billers', {}],
      ['ebill_download_bill', { bill_id: 'bc-001', output_path: `${srv.scratch}/a.pdf` }],
      ['ebill_download_all', { output_dir: `${srv.scratch}/all` }],
    ]) {
      await srv.call(name, args);
    }
    const methods = [...new Set(mock.state.calls.map(c => c.split(' ')[0]))];
    assert.deepEqual(methods, ['GET'], `something other than a GET left this process: ${methods}`);
  });

  test('nothing reaches a path that could change anything', async () => {
    // The portal's own inventory, from the reference: these are the endpoints
    // that alter a standing arrangement or release a payment. None of them may
    // appear, under any method.
    const forbidden = /approv|release|pay(ment)?s\/[^/?]+\/(approve|release|reject)|subscription|standing|sharing-permission|chargeback/i;
    const touched = mock.state.calls.filter(c => forbidden.test(c));
    assert.deepEqual(touched, [], `reached something that changes state: ${touched}`);
  });

  test('a path outside the allow-list is refused before it is sent', async () => {
    // Not reachable through a tool — which is the point. It is checked here by
    // asking for a bill id shaped like a path, because that is the one place a
    // caller's string reaches the URL, and the guard has to hold there.
    const before = mock.state.calls.length;
    const { isError } = await srv.call('ebill_download_bill', {
      bill_id: '../../api/v1/standing-approvals',
      output_path: `${srv.scratch}/x.pdf`,
    });
    assert.ok(isError, 'a path-shaped id was accepted');
    const after = mock.state.calls.slice(before);
    assert.ok(!after.some(c => c.includes('standing-approvals')),
      `a caller's string walked out of the archive: ${after}`);
  });

  test('the fixture would notice a POST, so the assertion above means something', async () => {
    // A test that asserts "only GETs arrived" against a fixture that silently
    // accepted a POST would pass for the wrong reason. It answers 405.
    const r = await fetch(`${mock.base}/ebill-portal/api/v1/payments`, { method: 'POST' });
    assert.equal(r.status, 405);
  });
});

describe('it says when it cannot know', () => {
  test('an expired banking session is named as one, not reported as an empty archive', async () => {
    mock.state.sessionExpired = true;
    try {
      const { raw, isError } = await srv.call('ebill_list_bills');
      assert.ok(isError);
      assert.match(raw, /session has expired/, raw);
      // The instruction matters more than the diagnosis: the fix is a human
      // logging in again, and nothing the caller can retry will help.
      assert.match(raw, /log in again/, raw);
    } finally {
      mock.state.sessionExpired = false;
    }
  });

  test('no browser at all is a different answer from no eBill tab', async () => {
    // Both are ordinary and the fixes differ — one is "start the window", the
    // other is "you are logged in but not on eBill". Reported apart.
    const s = await startServer({ EBILL_BASE_URL: mock.base, EBILL_CDP: 'http://127.0.0.1:1' });
    const { raw, isError } = await s.call('ebill_status');
    await s.stop();
    assert.ok(isError);
    assert.match(raw, /no browser is listening/, raw);
    assert.match(raw, /ebill_open/, 'never named the way out');
  });

  test('a window that is already up is not opened a second time', async () => {
    // The test browser is listening on the CDP endpoint this server was given,
    // which is exactly the state a second ebill_open call finds after a real
    // login. Launching again would put a fresh window in front of the one
    // holding the session, and the session is the thing that took a human.
    const { data, isError } = await srv.call('ebill_open', { url: 'https://example.invalid/login' });
    assert.ok(!isError, JSON.stringify(data));
    assert.equal(data.already_open, true, JSON.stringify(data));
    // And nothing was launched: the window still answers, and it is the same one.
    const { data: st } = await srv.call('ebill_status');
    assert.equal(st.session, 'reachable');
  });

  test('ebill_open refuses to guess a bank, and refuses a plain-http one', async () => {
    // EBILL_BANK_URL is set-and-empty in the harness, which is how "there is no
    // bank here" is said. Guessing one would open somebody's login page.
    const miss = await srv.call('ebill_open');
    assert.ok(miss.isError);
    assert.match(miss.raw, /does not guess which bank/, miss.raw);

    const plain = await srv.call('ebill_open', { url: 'http://example.invalid/login' });
    assert.ok(plain.isError, 'a plain-http bank login was accepted');
    assert.match(plain.raw, /non-https/, plain.raw);
  });
});

describe('nothing sensitive leaves the process', () => {
  test('no tool result and no stderr carries a cookie or a session token', async () => {
    const results = [];
    for (const [name, args] of [
      ['ebill_settings', {}],
      ['ebill_status', {}],
      ['ebill_list_bills', {}],
      ['ebill_billers', {}],
    ]) {
      results.push((await srv.call(name, args)).raw);
    }
    const blob = results.join('\n') + srv.stderr();
    // The session lives in the browser and is applied by it; nothing here ever
    // holds a token, and the way to keep that true is to check.
    assert.ok(!/set-cookie|sessionid=|bearer /i.test(blob), `something session-shaped surfaced:\n${blob.slice(0, 400)}`);
    assert.equal(srv.stderr(), '', 'the server logs nothing at all on stderr');
  });

  test('settings report the configuration without inventing a bank', async () => {
    const { data } = await srv.call('ebill_settings');
    assert.equal(data.portal, mock.base);
    assert.match(data.bank_url, /not set/);
    assert.ok(Array.isArray(data.readable_paths) && data.readable_paths.length, 'the allow-list is the promise; it is reported');
  });
});
