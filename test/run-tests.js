'use strict';
/**
 * Self-test: starts the mock website and checks the crawler finds exactly what was planted.
 *   npm test
 * Run it once after installing, and on a new build agent, to confirm Puppeteer + Chrome work there.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('./mock-app');
const { runLinkCheck } = require('../src');
const { writeReports } = require('../src/reports');

const quiet = () => {};
// The four required inputs. Tests pass them explicitly; the project itself has no defaults for them.
const check = (opts) => runLinkCheck({ maxBroken: 100, timeoutSec: 30, ...opts }, { log: quiet });
const brokenUrls = r => r.results.filter(x => x.broken).map(x => new URL(x.url).pathname + new URL(x.url).hash).sort();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let mock;
const base = () => mock.base;
const out = name => path.join(os.tmpdir(), 'blc-test', name);

test('web app (#/ routes, depth 5): finds every planted problem, including 5 clicks deep', async () => {
  const r = await check({ url: `${base()}/app/#/orders`, depth: 5, out: out('app') });
  assert.deepStrictEqual(brokenUrls(r), [
    '/api/deep-broken',          // 5 clicks from the start page
    '/api/gone',                 // dead link on #/customers
    '/api/order/1/missing',      // API call the page makes while loading
    '/app/#/orders/999',         // page loads but shows "Page not found"
    '/static/missing.png',       // broken image
  ]);
  assert.strictEqual(r.summary.pagesScanned, 7);
  const soft = r.results.find(x => x.url.endsWith('#/orders/999'));
  assert.match(soft.note, /not found/i);
  assert.ok(soft.screenshot && fs.existsSync(path.join(out('app'), soft.screenshot)), 'screenshot of the not-found page saved');
  assert.strictEqual(mock.hits.logout, 0, 'logout link must never be opened');
  writeReports(r, out('app'));
});

test('depth controls how far it goes', async () => {
  const r1 = await check({ url: `${base()}/app/#/orders`, depth: 1, out: out('d1') });
  assert.ok(!brokenUrls(r1).includes('/api/deep-broken'), 'depth 1 should not reach the deep link');
  assert.strictEqual(r1.summary.pagesScanned, 3);
  const r0 = await check({ url: `${base()}/app/#/orders`, depth: 0, out: out('d0') });
  assert.strictEqual(r0.summary.pagesScanned, 1);
});

test('maxPages stops the crawl and marks the rest unverified', async () => {
  const r = await check({ url: `${base()}/app/#/orders`, depth: 5, maxPages: 3, out: out('cap') });
  assert.ok(r.summary.pagesOpened <= 3);
  assert.ok(r.results.some(x => x.unverified && /maxPages/.test(x.note)));
});

test('plain multi-page site', async () => {
  const r = await check({ url: `${base()}/site/`, depth: 2, out: out('site') });
  assert.deepStrictEqual(brokenUrls(r), ['/site/logo-missing.png', '/site/old-page.html']);
  assert.strictEqual(r.summary.pagesScanned, 4);
});

test('without login: reports the redirect instead of crawling the login page', async () => {
  const r = await check({ url: `${base()}/secure/#/dashboard`, depth: 2, out: out('nologin') });
  assert.strictEqual(r.summary.broken, 0);
  assert.strictEqual(r.summary.pagesScanned, 0);
});

test('with login config: signs in and checks protected pages and files', async () => {
  process.env.TEST_USER = 'tester';
  process.env.TEST_PASSWORD = 's3cret';
  const { normalize } = require('../src/config');
  const r = await runLinkCheck(normalize({
    url: `${base()}/secure/#/dashboard`, depth: 2, maxBroken: 100, timeoutSec: 30, out: out('login'),
    login: { url: `${base()}/login`, username: process.env.TEST_USER, password: process.env.TEST_PASSWORD, usernameSelector: '#username', passwordSelector: '#password', submitSelector: 'button[type=submit]' },
  }), { log: quiet });
  assert.strictEqual(r.summary.pagesScanned, 3);
  assert.deepStrictEqual(brokenUrls(r), ['/secure-files/q2-missing.pdf']);
  const ok = r.results.find(x => x.url.endsWith('/secure-files/q3.pdf'));
  assert.strictEqual(ok.status, 200, 'file behind login checked with the signed-in cookies');
});

test('wrong password fails clearly', async () => {
  await assert.rejects(
    check({ url: `${base()}/secure/#/dashboard`, depth: 1, out: out('badlogin'), login: { url: `${base()}/login`, username: 'tester', password: 'nope', usernameSelector: '#username', passwordSelector: '#password', submitSelector: 'button[type=submit]' } }),
    /Login failed/,
  );
});

test('the four inputs are required — nothing is hard-coded', async () => {
  await assert.rejects(runLinkCheck({ out: out('req') }, { log: quiet }), e => {
    for (const f of ['--url', '--depth', '--max-broken', '--timeout']) assert.ok(e.message.includes(f), `error should mention ${f}`);
    return true;
  });
  await assert.rejects(runLinkCheck({ url: `${base()}/site/`, depth: 1, timeoutSec: 30, out: out('req2') }, { log: quiet }), /--max-broken/);
});

test('timeout: a page slower than the timeout fails', async () => {
  const r = await check({ url: `${base()}/slow/`, depth: 1, timeoutSec: 2, out: out('slow') });
  const slow = r.results.find(x => x.url.endsWith('/slow/slow.html'));
  assert.ok(slow.broken, 'slow page should be broken');
  assert.match(slow.note, /did not load within 2s/i);
  assert.ok(!r.results.find(x => x.url.endsWith('/slow/fast.html')).broken);
});

test('max broken: stops once the limit is reached', async () => {
  const r = await check({ url: `${base()}/app/#/orders`, depth: 5, maxBroken: 2, out: out('maxbroken') });
  assert.strictEqual(r.summary.stoppedEarly, true);
  assert.ok(r.summary.broken >= 2 && r.summary.broken < 5, `expected to stop near 2, got ${r.summary.broken}`);
  assert.ok(!r.results.some(x => x.url.endsWith('/api/deep-broken') && x.broken), 'should not have reached the deep link');
  assert.ok(r.results.some(x => /stopped after 2 broken/.test(x.note)));
});

test('command line: inputs from environment variables, exit code, reports', async () => {
  const { spawn } = require('child_process');
  const dir = out('cli');
  const env = { ...process.env, LINKCHECK_URL: `${base()}/site/`, LINKCHECK_DEPTH: '2', LINKCHECK_MAX_BROKEN: '50', LINKCHECK_TIMEOUT_SEC: '30' };
  // Async spawn: the mock site runs in this process, so it must keep serving while the CLI runs
  const run = (args, extraEnv = {}) => new Promise(resolve => {
    const c = spawn(process.execPath, [path.join(__dirname, '../src/cli.js'), '--out', dir, ...args], { env: { ...env, ...extraEnv } });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; });
    c.stderr.on('data', d => { stderr += d; });
    c.on('close', status => resolve({ status, stdout, stderr }));
  });
  let p = await run([]);
  assert.strictEqual(p.status, 0, p.stderr || p.stdout);
  assert.match(p.stdout, /Depth: 2 \| Max broken links: 50 \| Timeout: 30s/);
  for (const f of ['report.html', 'report.json', 'junit.xml']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  p = await run(['--fail-on-broken']);
  assert.strictEqual(p.status, 1, 'broken links + --fail-on-broken should exit 1');
  p = await run(['--max-broken', '1']);
  assert.strictEqual(p.status, 1, 'hitting max broken should exit 1');
  assert.match(p.stdout, /Stopped early/);
  p = await run([], { LINKCHECK_DEPTH: '' });
  assert.strictEqual(p.status, 2, 'missing depth should exit 2');
  assert.match(p.stderr, /--depth/);
});

(async () => {
  mock = await start();
  console.log(`Mock site at ${mock.base}\n`);
  let failed = 0;
  for (const t of tests) {
    const t0 = Date.now();
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${t.name}\n      ${String(e.message).split('\n').join('\n      ')}`);
    }
  }
  mock.server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed. Sample report: ${path.join(out('app'), 'report.html')}`);
  process.exit(failed ? 1 : 0);
})();
