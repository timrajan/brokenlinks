'use strict';
/**
 * Checks links that aren't opened as pages (images, scripts, files, external sites) with a
 * plain HTTP request from Node. Unlike the browser console there is no CORS here, so external
 * links get real status codes. Same-site requests carry the browser's cookies, so pages behind
 * a login are checked as the signed-in user.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 BrokenLinkChecker/1.0';

// Sites that commonly refuse automated requests even though the link works
const BOT_BLOCK_STATUSES = new Set([401, 403, 429, 999]);

function cookieHeaderFor(url, cookies) {
  if (!cookies || !cookies.length) return '';
  const u = new URL(url);
  const host = u.hostname;
  return cookies
    .filter(c => {
      const d = (c.domain || '').replace(/^\./, '');
      const domainOk = c.domain && c.domain.startsWith('.') ? (host === d || host.endsWith('.' + d)) : host === d;
      const pathOk = u.pathname.startsWith(c.path || '/');
      const secureOk = !c.secure || u.protocol === 'https:';
      const notExpired = !c.expires || c.expires < 0 || c.expires * 1000 > Date.now();
      return domainOk && pathOk && secureOk && notExpired;
    })
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function errorText(e, timeoutMs) {
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return `Did not respond within ${timeoutMs / 1000}s (timeout)`;
  return e.cause?.code || e.cause?.errors?.[0]?.code || e.cause?.message || e.message;
}

async function request(url, method, { timeoutMs, cookies }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { 'User-Agent': UA, Accept: '*/*' };
  const cookie = cookieHeaderFor(url, cookies);
  if (cookie) headers.Cookie = cookie;
  try {
    const res = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal, headers });
    res.body?.cancel().catch(() => {});
    return { status: res.status, statusText: res.statusText, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {{status:number, broken:boolean, unverified?:boolean, note:string, ms:number}}
 */
async function checkUrl(url, { timeoutMs = 15000, cookies = [], startOrigin = '' } = {}) {
  const t = Date.now();
  const external = startOrigin && new URL(url).origin !== startOrigin;
  try {
    let r = await request(url, 'HEAD', { timeoutMs, cookies });
    // Many servers reject HEAD (405/403/501) — retry with GET before calling it broken
    if (r.status >= 400) r = await request(url, 'GET', { timeoutMs, cookies });
    const ms = Date.now() - t;
    if (r.status >= 400 && external && BOT_BLOCK_STATUSES.has(r.status)) {
      return { status: r.status, broken: false, unverified: true, note: `${r.statusText || 'Refused'} — site may block automated checks; verify manually`, ms };
    }
    return { status: r.status, broken: r.status >= 400, note: r.statusText || '', ms };
  } catch (e) {
    return { status: 0, broken: true, note: errorText(e, timeoutMs), ms: Date.now() - t };
  }
}

module.exports = { checkUrl, cookieHeaderFor };
