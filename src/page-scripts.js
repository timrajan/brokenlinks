'use strict';
/**
 * Functions that run INSIDE the browser page (passed to page.evaluate).
 * They must be self-contained: no references to anything outside the function body.
 */

/** Resolves once the DOM has stopped changing for settleMs (or after maxMs). */
function waitForDomSettle(settleMs, maxMs) {
  return new Promise(resolve => {
    let quiet;
    let obs;
    const done = () => { clearTimeout(hard); clearTimeout(quiet); if (obs) obs.disconnect(); resolve(); };
    const hard = setTimeout(done, maxMs);
    const kick = () => { clearTimeout(quiet); quiet = setTimeout(done, settleMs); };
    obs = new MutationObserver(kick);
    obs.observe(document, { subtree: true, childList: true, characterData: true });
    kick();
  });
}

/**
 * Reads every link on the page (including shadow DOM and same-origin iframes) and
 * a few facts used to spot "page not found" screens.
 */
function collectPageInfo(opts) {
  const NOT_FOUND = new RegExp(opts.notFoundText, 'i');
  const isRouteHash = h => /^#!?\//.test(h || '');
  const usesHashRouting = isRouteHash(location.hash) || !!document.querySelector('a[href^="#/"],a[href^="#!/"]');

  function norm(raw, base) {
    raw = (raw || '').trim();
    if (!raw || /^(mailto:|tel:|javascript:|data:|blob:|about:)/i.test(raw)) return null;
    if (raw.startsWith('#') && !isRouteHash(raw)) return null;          // in-page anchor like #section
    let u;
    try { u = new URL(raw, base); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!isRouteHash(u.hash)) u.hash = '';                               // keep '#/route', drop '#section'
    return u.href;
  }

  const links = new Map();
  const SEL = 'a[href],area[href],link[href],img[src],script[src],iframe[src],source[src],video[src],audio[src],[routerlink],[ng-href]';
  const walk = (root, base) => {
    root.querySelectorAll(SEL).forEach(el => {
      let raw = el.getAttribute('href') ?? el.getAttribute('ng-href') ?? el.getAttribute('src');
      let tag = el.tagName.toLowerCase();
      if (raw == null && el.hasAttribute('routerlink')) {                 // Angular routerLink on non-<a> elements
        raw = el.getAttribute('routerlink');
        if (usesHashRouting && raw.startsWith('/')) raw = '#' + raw;
        tag = 'a';
      }
      if (tag === 'area') tag = 'a';
      if (tag === 'link' && /preconnect|dns-prefetch|canonical|alternate/i.test(el.getAttribute('rel') || '')) return;
      const url = norm(raw, base);
      if (!url || links.has(url)) return;
      const text = tag === 'a' ? (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 80) : '';
      links.set(url, { url, tag, text });
    });
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) walk(el.shadowRoot, base);
      if (el.tagName === 'IFRAME') {
        try { if (el.contentDocument) walk(el.contentDocument, el.contentDocument.location.href); } catch (e) { /* cross-origin frame */ }
      }
    });
  };
  walk(document, location.href);

  const title = document.title || '';
  const headings = [...document.querySelectorAll('h1,h2,[role=heading]')].slice(0, 4).map(e => e.textContent.trim()).filter(Boolean).join(' | ');
  const text = (document.body && document.body.innerText || '').trim();
  const soft404 = NOT_FOUND.test(title) || NOT_FOUND.test(headings) || (text.length < 400 && NOT_FOUND.test(text));

  return {
    finalUrl: location.href,
    title,
    headings: headings.slice(0, 120),
    textLength: text.length,
    soft404,
    anchorCount: document.querySelectorAll('a[href]').length,
    links: [...links.values()],
  };
}

module.exports = { waitForDomSettle, collectPageInfo };
