'use strict';
/**
 * A small fake website used by the self-test. It has:
 *  - /app/      a hash-routed single-page app ('#/orders', '#/customers', ...) whose links are drawn by JavaScript
 *  - /secure/   the same kind of app behind a login (cookie session)
 *  - /site/     a plain multi-page HTML site
 * with broken things planted at known places.
 */
const http = require('http');

const appShell = (title, routes, { notFoundTitle = 'Not found' } = {}) => `<!doctype html><html><head><title>${title}</title></head>
<body><nav><a href="#top">Skip to content</a></nav><div id="root">Loading...</div>
<script>
const routes = ${JSON.stringify(routes)};
function draw() {
  const p = location.hash.slice(1) || '/';
  document.getElementById('root').innerHTML = 'Loading...';
  setTimeout(() => {
    const r = routes[p];
    document.getElementById('root').innerHTML = r ? r.html : '<h1>Page not found</h1><p>The page you requested does not exist.</p>';
    document.title = r ? ${JSON.stringify(title)} : ${JSON.stringify(notFoundTitle)};
    if (r && r.fetch) fetch(r.fetch).catch(() => {});
  }, 300);
}
addEventListener('hashchange', draw); draw();
</script></body></html>`;

const APP_ROUTES = {
  '/': { html: '<h1>Home</h1><a href="#/orders">Orders</a> <a href="#/customers">Customers</a>' },
  '/orders': { html: '<h1>Orders</h1><a href="#/orders/1">Order 1</a> <a href="#/orders/999">Order 999</a> <a href="#/customers">Customers</a> <img src="/static/missing.png"> <a href="/logout">Log out</a> <a href="/files/report.pdf">Report PDF</a>' },
  '/orders/1': { html: '<h1>Order 1</h1><a href="#/orders">Back</a> <a href="/files/invoice-1.pdf">Invoice</a>', fetch: '/api/order/1/missing' },
  '/customers': { html: '<h1>Customers</h1><a href="#/customers/7">Customer 7</a> <a href="/api/gone">Old export</a>' },
  '/customers/7': { html: '<h1>Customer 7</h1><a href="#/orders">Orders</a> <a href="#/customers/7/notes">Notes</a>' },
  '/customers/7/notes': { html: '<h1>Notes</h1><a href="#/notes/1">Note 1</a>' },
  '/notes/1': { html: '<h1>Note 1</h1><a href="#/notes/1/history">History</a>' },
  '/notes/1/history': { html: '<h1>History</h1><a href="/api/deep-broken">Deep link</a>' },
};

const SECURE_ROUTES = {
  '/dashboard': { html: '<h1>Dashboard</h1><a href="#/reports">Reports</a> <a href="#/settings">Settings</a>' },
  '/reports': { html: '<h1>Reports</h1><a href="/secure-files/q3.pdf">Q3</a> <a href="/secure-files/q2-missing.pdf">Q2</a>' },
  '/settings': { html: '<h1>Settings</h1><a href="#/dashboard">Back</a>' },
};

const LOGIN_PAGE = `<!doctype html><html><head><title>Sign in</title></head><body><h1>Sign in</h1>
<form method="post" action="/do-login"><input id="username" name="username"><input id="password" name="password" type="password">
<button type="submit">Sign in</button></form></body></html>`;

const SITE = {
  '/site/': '<!doctype html><title>Site home</title><h1>Welcome</h1><a href="/site/about.html">About</a> <a href="/site/contact.html">Contact</a> <a href="/site/old-page.html">Old page</a>',
  '/site/about.html': '<!doctype html><title>About</title><h1>About</h1><a href="/site/">Home</a> <a href="/site/team.html">Team</a> <img src="/site/logo-missing.png">',
  '/site/contact.html': '<!doctype html><title>Contact</title><h1>Contact</h1><a href="/site/">Home</a>',
  '/site/team.html': '<!doctype html><title>Team</title><h1>Team</h1><a href="/site/about.html">About</a>',
};

const SLOW = {
  '/slow/': '<!doctype html><title>Slow site</title><h1>Slow</h1><a href="/slow/fast.html">Fast page</a> <a href="/slow/slow.html">Slow page</a>',
  '/slow/fast.html': '<!doctype html><title>Fast</title><h1>Fast</h1>',
  '/slow/slow.html': '<!doctype html><title>Slow</title><h1>Eventually</h1>',
};

const FILES = new Set(['/files/report.pdf', '/files/invoice-1.pdf', '/secure-files/q3.pdf']);

function start(port = 0) {
  const hits = { logout: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const signedIn = /(?:^|;\s*)session=ok/.test(req.headers.cookie || '');
    const send = (code, type, body, headers = {}) => { res.writeHead(code, { 'content-type': type, ...headers }); res.end(req.method === 'HEAD' ? undefined : body); };

    if (p === '/app/') return send(200, 'text/html', appShell('Orders App', APP_ROUTES));
    if (p === '/logout') { hits.logout++; return send(302, 'text/plain', '', { location: '/login', 'set-cookie': 'session=; Path=/; Max-Age=0' }); }
    if (p === '/login') return send(200, 'text/html', LOGIN_PAGE);
    if (p === '/do-login' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const f = new URLSearchParams(body);
        if (f.get('username') === 'tester' && f.get('password') === 's3cret') {
          send(302, 'text/plain', '', { location: '/secure/#/dashboard', 'set-cookie': 'session=ok; Path=/; HttpOnly' });
        } else send(302, 'text/plain', '', { location: '/login?error=1' });
      });
      return;
    }
    if (p === '/secure/') return signedIn ? send(200, 'text/html', appShell('Secure App', SECURE_ROUTES)) : send(302, 'text/plain', '', { location: '/login' });
    if (p.startsWith('/secure-files/')) {
      if (!signedIn) return send(302, 'text/plain', '', { location: '/login' });
      return FILES.has(p) ? send(200, 'application/pdf', '%PDF-1.4') : send(404, 'text/plain', 'not found');
    }
    if (SITE[p]) return send(200, 'text/html', SITE[p]);
    if (p === '/slow/slow.html') { setTimeout(() => send(200, 'text/html', SLOW[p]), 5000); return; }
    if (SLOW[p]) return send(200, 'text/html', SLOW[p]);
    if (FILES.has(p)) return send(200, 'application/pdf', '%PDF-1.4');
    send(404, 'text/plain', 'not found');
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { start };

if (require.main === module) {
  start(Number(process.argv[2]) || 8780).then(({ base }) => console.log(`Mock app running at ${base}/app/#/orders  ${base}/site/  ${base}/secure/#/dashboard (tester / s3cret)`));
}
