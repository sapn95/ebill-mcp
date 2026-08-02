// A throwaway stand-in for the window the user logs in with.
//
// The server never launches the browser it reads through — it attaches to one
// over CDP, because the login is second-factor-bound and belongs to a human. So
// the tests have to provide that window, and the only faithful way to do it is
// a real Chromium with remote debugging on, holding a real page open at the
// fixture. Anything cheaper would test a different program.
//
// Headless here, which the real thing cannot be: nobody has to type into this
// one. Its own profile directory, removed with the scratch dir afterwards — a
// leftover profile keeps a SingletonLock and the next run cannot start at all.
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

// Port 0 bound and released: asking the OS for a free one is the only way to
// avoid two suites racing for 9222, and a hard-coded port would also collide
// with a real logged-in window on the developer's own machine — which is the
// one collision that could point a test at a bank.
const freePort = () => new Promise(resolve => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

export async function startBrowser(pageUrl) {
  const profile = mkdtempSync(join(tmpdir(), 'ebill-profile-'));
  const port = await freePort();
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    args: [`--remote-debugging-port=${port}`],
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  return {
    cdp: `http://127.0.0.1:${port}`,
    page,
    close: async () => {
      await ctx.close().catch(() => {});
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
