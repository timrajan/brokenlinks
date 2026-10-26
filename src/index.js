'use strict';
/**
 * Broken link crawler driven by Puppeteer.
 *
 * Each same-site page is opened in a real browser tab, the app is given time to draw, and
 * the links are read from the live DOM. Links are followed level by level up to `depth`.
 * Everything that isn't opened as a page (images, files, external sites) is checked with
 * an HTTP request. Broken resources that fail while a page loads (images, scripts, API
 * calls) are captured from the browser's network traffic.
 *
 *   const { runLinkCheck } = require('broken-link-checker');
 *   const report = await runLinkCheck({ url: 'https://myapp/#/orders', depth: 3 });
 */
const fs = require('fs');
const path = require('path');
const { normalize } = require('./config');
const { waitForDomSettle, collectPageInfo } = require('./page-scripts');
const { checkUrl } = require('./http-check');
const { runLogin } = require('./login');

const SKIP_EXT = /\.(pdf|zip|gz|rar|7z|png|jpe?g|gif|svg|webp|ico|bmp|css|js|mjs|map|json|xml|txt|mp4|webm|mp3|wav|woff2?|ttf|eot|otf|docx?|xlsx?|pptx?|csv|exe|msi|dmg)$/i;
const isRouteHash = h => /^#!?\//.test(h || '');
// Chrome asks for /favicon.ico on its own — not a link on the page, so don't report it
const isAutoFavicon = req => req.resourceType() === 'other' && /\/favicon\.ico(\?|$)/i.test(req.url());

function loadPuppeteer() {
  for (const name of ['puppeteer', 'puppeteer-core']) {
    try { return require(name); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error('Puppeteer is not installed. Run: npm install');
}

function normUrl(raw, base) {
  let u;
  try { u = new URL(raw, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!isRouteHash(u.hash)) u.hash = '';
  return u.href;
}

async function pool(items, n, fn, shouldStop = () => false) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !shouldStop()) { const idx = i++; await fn(items[idx], idx); }
  }));
}

async function getAllCookies(browser) {
  const page = await browser.newPage();
  try {
    const cdp = await page.createCDPSession();
    const res = await cdp.send('Storage.getCookies').catch(() => cdp.send('Network.getAllCookies'));
    return res.cookies || [];
  } catch {
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

async function runLinkCheck(options, { log = console.log } = {}) {
  const cfg = normalize(options);
  const t0 = Date.now();
  const EXCLUDE = cfg.exclude ? new RegExp(cfg.exclude, 'i') : null;
  const LOGIN_URL = new RegExp(cfg.loginUrlPattern, 'i');
  const ignoreTypes = new Set(cfg.ignoreResourceTypes || []);
  const shotsDir = path.join(cfg.out, 'screenshots');
  let shotCount = 0;

  const puppeteer = loadPuppeteer();
  const launchOpts = {
    headless: !cfg.headful,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],  // needed on most CI agents
    defaultViewport: cfg.viewport,
  };
  if (cfg.chrome) launchOpts.executablePath = cfg.chrome;
  log(`Launching ${cfg.chrome || 'Puppeteer Chrome'}${cfg.headful ? ' (visible)' : ''} ...`);
  const browser = await puppeteer.launch(launchOpts);

  const links = new Map();      // url -> { url, tag, text, foundOn:Set, result }
  const pages = [];             // pages whose links were read
  const visited = new Set();    // pages queued/opened
  let opened = 0;
  let capWarned = false;
  let startOrigin;
  let startUrl = normUrl(cfg.url);

  const record = (l, pageUrl) => {
    if (!links.has(l.url)) links.set(l.url, { url: l.url, tag: l.tag, text: l.text || '', foundOn: new Set() });
    const entry = links.get(l.url);
    entry.foundOn.add(pageUrl);
    if (!entry.text && l.text) entry.text = l.text;
    return entry;
  };
  // ---- maxBroken: stop as soon as this many unique broken links have been found ----
  const brokenFound = new Set();
  let stopped = false;
  const isStopped = () => stopped;
  const noteBroken = (url, result) => {
    if (!result || !result.broken || brokenFound.has(url)) return;
    brokenFound.add(url);
    if (!stopped && brokenFound.size >= cfg.maxBroken) {
      stopped = true;
      log(`\n⛔ Reached max broken links (${cfg.maxBroken}) — stopping the check.`);
    }
  };

  const pageResults = new Map(); // results for pages opened during the crawl
  const setResult = (url, result) => { if (!pageResults.has(url)) { pageResults.set(url, result); noteBroken(url, result); } };
  const excluded = url => EXCLUDE && EXCLUDE.test(url);
  const isPage = (url, tag) => {
    const u = new URL(url);
    return tag === 'a' && u.origin === startOrigin && !SKIP_EXT.test(u.pathname) && !excluded(url) && (!cfg.scope || url.startsWith(cfg.scope));
  };

  async function screenshot(page, label) {
    if (!cfg.screenshots) return null;
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      const file = `${String(++shotCount).padStart(3, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.png`;
      // Screenshots of background tabs can stall in headless Chrome: bring the tab forward and cap the wait
      const shot = (async () => { await page.bringToFront(); await page.screenshot({ path: path.join(shotsDir, file), captureBeyondViewport: false }); })();
      shot.catch(() => {});
      await Promise.race([shot, new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timeout')), 10000))]);
      return `screenshots/${file}`;
    } catch { return null; }
  }

  /**
   * Opens one page in a new tab. Returns { result, info } — info is null if links weren't read.
   */
  async function visitPage(url, { readLinks }) {
    const t = Date.now();
    const page = await browser.newPage();
    const jsErrors = [];
    const resourceIssues = [];
    page.on('pageerror', e => jsErrors.push(String(e.message || e).split('\n')[0]));
    if (cfg.checkResources) {
      page.on('response', res => {
        const req = res.request();
        const type = req.resourceType();
        if (res.status() >= 400 && type !== 'document' && !ignoreTypes.has(type) && !isAutoFavicon(req)) {
          resourceIssues.push({ url: res.url(), type, status: res.status(), note: `${res.statusText() || 'HTTP ' + res.status()} (${type} requested while loading the page)` });
        }
      });
      page.on('requestfailed', req => {
        const err = req.failure()?.errorText || '';
        const type = req.resourceType();
        if (err && !/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(err) && type !== 'document' && !ignoreTypes.has(type) && !isAutoFavicon(req)) {
          resourceIssues.push({ url: req.url(), type, status: 0, note: `${err} (${type} requested while loading the page)` });
        }
      });
    }

    try {
      let resp;
      try {
        resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.pageTimeout });
      } catch (e) {
        const msg = String(e.message).split('\n')[0];
        // Navigating to a download (file) aborts — treat like a file link and check it over HTTP
        if (/ERR_ABORTED/.test(msg)) return { result: null, info: null, retryHttp: true };
        const note = /timeout/i.test(e.name + msg) ? `Page did not load within ${cfg.timeoutSec}s (timeout)` : msg;
        return { result: { status: 0, broken: true, note, ms: Date.now() - t, screenshot: await screenshot(page, url) }, info: null };
      }
      const status = resp ? resp.status() : 200;
      const ctype = resp ? (resp.headers()['content-type'] || '') : 'text/html';
      if (status >= 400) {
        return { result: { status, broken: true, note: resp.statusText() || `HTTP ${status}`, ms: Date.now() - t, screenshot: await screenshot(page, url) }, info: null };
      }
      if (ctype && !/html/i.test(ctype)) {
        return { result: { status, broken: false, note: `OK (${ctype.split(';')[0]})`, ms: Date.now() - t }, info: null };
      }

      await page.waitForNetworkIdle({ idleTime: 400, timeout: cfg.pageTimeout }).catch(() => {});
      await page.evaluate(waitForDomSettle, cfg.settleMs, Math.min(cfg.pageTimeout, 15000)).catch(() => {});
      const info = await page.evaluate(collectPageInfo, { notFoundText: cfg.notFoundText });
      const ms = Date.now() - t;

      const wentToLogin = info.finalUrl !== url && LOGIN_URL.test(info.finalUrl) && !LOGIN_URL.test(url);
      let result;
      if (info.soft404) {
        result = { status, broken: true, ms, note: `Page shows "not found" — title: "${info.title}"${info.headings ? `, heading: "${info.headings}"` : ''}`, screenshot: await screenshot(page, url) };
      } else if (wentToLogin) {
        result = { status, broken: false, unverified: true, ms, note: `Redirected to login (${info.finalUrl}) — configure login to check this page` };
      } else if (!info.textLength && !info.links.length) {
        result = { status, broken: false, unverified: true, ms, note: 'Page rendered empty', screenshot: await screenshot(page, url) };
      } else {
        result = { status, broken: false, ms, note: 'Page OK' };
      }
      if (jsErrors.length) result.note += ` · ${jsErrors.length} JavaScript error(s): ${jsErrors[0].slice(0, 120)}`;
      result.title = info.title;

      for (const r of resourceIssues) {
        const u = normUrl(r.url);
        if (!u || excluded(u)) continue;
        const entry = record({ url: u, tag: r.type }, url);
        if (!entry.result) { entry.result = { status: r.status, broken: true, note: r.note, ms: 0 }; noteBroken(u, entry.result); }
      }
      const usable = readLinks && !info.soft404 && !wentToLogin;
      return { result, info: usable ? info : null };
    } finally {
      await page.close().catch(() => {});
    }
  }

  try {
    await runLogin(browser, cfg, log);

    // ---------- crawl, level by level ----------
    let frontier = [startUrl];
    visited.add(startUrl);
    for (let depth = 0; depth <= cfg.depth && frontier.length && !stopped; depth++) {
      log(`\n[depth ${depth}] opening ${frontier.length} page(s)...`);
      const next = [];
      let n = 0;
      await pool(frontier, cfg.concurrency, async (url) => {
        if (opened >= cfg.maxPages) {
          if (!capWarned) { capWarned = true; log(`  Reached maxPages (${cfg.maxPages}) — remaining pages listed as unverified. Raise --max-pages to go further.`); }
          setResult(url, { status: '', broken: false, unverified: true, note: `Not opened (maxPages ${cfg.maxPages} reached)`, ms: 0 });
          return;
        }
        opened++;
        const { result, info, retryHttp } = await visitPage(url, { readLinks: true });
        if (retryHttp) return;   // it was a file download — checked over HTTP later
        if (url === startUrl) {
          if (result.broken && !info) throw new Error(`Start page is broken: ${result.status} ${result.note}`);
          if (info) {
            const finalStart = normUrl(info.finalUrl);
            startOrigin = new URL(finalStart).origin;
            const viaLogin = LOGIN_URL.test(info.finalUrl) && !LOGIN_URL.test(url);
            if (viaLogin) log(`  ⚠ Start page redirected to ${info.finalUrl} — you are probably not signed in. See "login" in the README.`);
          }
        }
        setResult(url, result);
        if (!startOrigin) startOrigin = new URL(url).origin;
        const label = `  ${++n}/${frontier.length} ${result.broken ? '✗' : result.unverified ? '?' : '✓'} ${url}`;
        if (!info) { log(`${label}${result.broken || result.unverified ? '  (' + result.note + ')' : ''}`); return; }

        pages.push({ url, title: info.title, status: result.status, links: info.links.length, ms: result.ms });
        log(`${label} -> ${info.links.length} links`);
        if (url === startUrl && info.links.length === 0) log(`  ⚠ No links found on the start page (<a> elements: ${info.anchorCount}). Try a larger --settle if the app draws slowly.`);
        for (const l of info.links) {
          if (excluded(l.url)) continue;
          const internal = new URL(l.url).origin === startOrigin;
          if (cfg.internalOnly && !internal) continue;
          record(l, url);
          if (depth < cfg.depth && isPage(l.url, l.tag) && !visited.has(l.url)) { visited.add(l.url); next.push(l.url); }
        }
      }, isStopped);
      frontier = next;
    }

    // Pages opened above that are also links on other pages get the page's result
    for (const l of links.values()) if (!l.result && pageResults.has(l.url)) l.result = pageResults.get(l.url);

    // ---------- last level: open same-site pages to catch "not found" screens ----------
    const pending = [...links.values()].filter(l => !l.result);
    const lastPages = cfg.checkLastLevelPages && !stopped ? pending.filter(l => isPage(l.url, l.tag) && !visited.has(l.url)) : [];
    if (lastPages.length) {
      log(`\nOpening ${lastPages.length} last-level page(s) to check they load...`);
      let n = 0;
      await pool(lastPages, cfg.concurrency, async (l) => {
        visited.add(l.url);
        if (opened >= cfg.maxPages) {
          l.result = { status: '', broken: false, unverified: true, note: `Not opened (maxPages ${cfg.maxPages} reached)`, ms: 0 };
          return;
        }
        opened++;
        const { result, retryHttp } = await visitPage(l.url, { readLinks: false });
        if (!retryHttp) { l.result = result; noteBroken(l.url, result); }
        n++;
        if (result?.broken) log(`  ✗ ${l.url}  (${result.note})`);
        else if (n % 20 === 0 || n === lastPages.length) log(`  ${n}/${lastPages.length}`);
      }, isStopped);
    }

    // ---------- everything else: HTTP check ----------
    const rest = stopped ? [] : [...links.values()].filter(l => !l.result);
    if (rest.length) {
      log(`\nChecking ${rest.length} other link(s) (files, images, external sites)...`);
      const cookies = await getAllCookies(browser);
      await pool(rest, cfg.linkConcurrency, async (l) => {
        if (isRouteHash(new URL(l.url).hash)) {
          l.result = { status: '', broken: false, unverified: true, note: 'App page not opened (beyond depth)', ms: 0 };
          return;
        }
        l.result = await checkUrl(l.url, { timeoutMs: cfg.requestTimeout, cookies, startOrigin });
        if (l.result.broken) log(`  ✗ ${String(l.result.status || 'ERR').padEnd(4)} ${l.url}  (${l.result.note})`);
        noteBroken(l.url, l.result);
      }, isStopped);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Anything not reached because the check stopped early
  for (const l of links.values()) {
    if (!l.result && pageResults.has(l.url)) l.result = pageResults.get(l.url);
    if (!l.result) l.result = { status: '', broken: false, unverified: true, note: stopped ? `Not checked — stopped after ${cfg.maxBroken} broken links` : 'Not checked', ms: 0 };
  }

  const results = [...links.values()].map(l => ({
    url: l.url,
    type: l.tag,
    text: l.text,
    status: l.result.status,
    broken: !!l.result.broken,
    unverified: !!l.result.unverified,
    note: l.result.note,
    screenshot: l.result.screenshot || null,
    ms: l.result.ms,
    foundOn: [...l.foundOn],
  }));
  const summary = {
    pagesScanned: pages.length,
    pagesOpened: opened,
    total: results.length,
    broken: results.filter(r => r.broken).length,
    unverified: results.filter(r => r.unverified).length,
    ok: results.filter(r => !r.broken && !r.unverified).length,
    maxBroken: cfg.maxBroken,
    stoppedEarly: stopped,
  };
  return { startUrl, depth: cfg.depth, config: cfg, checkedAt: new Date().toISOString(), durationMs: Date.now() - t0, summary, pages, results };
}

module.exports = { runLinkCheck };
