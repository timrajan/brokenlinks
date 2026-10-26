'use strict';
const fs = require('fs');
const path = require('path');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function htmlReport(report) {
  const { startUrl, depth, checkedAt, durationMs, summary, pages, results } = report;
  const rows = [...results]
    .sort((a, b) => b.broken - a.broken || b.unverified - a.unverified || a.url.localeCompare(b.url))
    .map(r => {
      const cls = r.broken ? 'bad' : r.unverified ? 'warn ok' : 'ok';
      const mark = r.broken ? '✗' : r.unverified ? '?' : '✓';
      const shot = r.screenshot ? ` <a class="shot" href="${esc(r.screenshot)}" target="_blank">screenshot</a>` : '';
      const text = r.text ? `<div class="txt">"${esc(r.text)}"</div>` : '';
      return `<tr class="${cls}"><td>${mark}</td><td>${esc(r.status === 0 ? 'ERR' : r.status)}</td><td>${esc(r.type)}</td>
<td><a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a>${text}</td><td>${esc(r.note)}${shot}</td>
<td class="on">${r.foundOn.map(p => `<a href="${esc(p)}" target="_blank">${esc(p)}</a>`).join('<br>')}</td><td>${r.ms ?? ''}</td></tr>`;
    }).join('\n');
  const pageRows = pages.map(p => `<tr><td><a href="${esc(p.url)}" target="_blank">${esc(p.url)}</a></td><td>${esc(p.title)}</td><td>${p.links}</td><td>${p.ms}</td></tr>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link report</title>
<style>
body{font:14px system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;color:#222;background:#fff}h1{font-size:20px;margin:0 0 6px}
.meta{color:#555;margin:0 0 12px}.sum{display:flex;gap:12px;margin:12px 0;flex-wrap:wrap}.sum div{padding:10px 16px;border-radius:8px;background:#f2f2f2;min-width:90px}
.sum b{display:block;font-size:22px}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}
th{background:#fafafa;position:sticky;top:0}td:nth-child(4),td.on{word-break:break-all}td.on{font-size:12px;color:#555}.txt{font-size:12px;color:#777}
tr.bad{background:#fdecec}tr.bad td:first-child{color:#c00;font-weight:bold}tr.ok td:first-child{color:#090}
tr.warn{background:#fff8e1}tr.warn td:first-child{color:#b26a00;font-weight:bold}.shot{font-size:12px;white-space:nowrap}
.stop{background:#fdecec;border:1px solid #f3b4b4;padding:8px 12px;border-radius:6px;color:#900;font-weight:600}
.bar{margin:10px 0;display:flex;gap:16px;align-items:center;flex-wrap:wrap}details{margin:8px 0}input[type=search]{padding:5px 8px;min-width:260px}
</style></head><body>
<h1>Broken link report</h1>
<p class="meta">Start URL: <a href="${esc(startUrl)}" target="_blank">${esc(startUrl)}</a><br>Depth ${depth} · max broken links ${summary.maxBroken} · timeout ${esc(report.config.timeoutSec)}s<br>Checked: ${esc(checkedAt)} · ${(durationMs / 1000).toFixed(1)}s · Puppeteer</p>
${summary.stoppedEarly ? `<p class="stop">⛔ Stopped early: reached the maximum of ${summary.maxBroken} broken links. Links not reached are marked "Not checked".</p>` : ''}
<div class="sum"><div><b>${summary.pagesScanned}</b>pages scanned</div><div><b>${summary.total}</b>unique links</div>
<div style="background:#fdecec"><b>${summary.broken}</b>broken</div><div style="background:#e8f6e8"><b>${summary.ok}</b>OK</div>
${summary.unverified ? `<div style="background:#fff8e1"><b>${summary.unverified}</b>unverified</div>` : ''}</div>
<details><summary>Pages scanned (${pages.length})</summary><table><thead><tr><th>Page</th><th>Title</th><th>Links</th><th>ms</th></tr></thead><tbody>${pageRows}</tbody></table></details>
<div class="bar"><label><input type="checkbox" id="brokenOnly"> Show broken only</label><input type="search" id="q" placeholder="Filter by URL or page..."></div>
<table id="links"><thead><tr><th></th><th>Status</th><th>Type</th><th>URL</th><th>Detail</th><th>Found on</th><th>ms</th></tr></thead><tbody>
${rows}
</tbody></table>
<script>
const rows=[...document.querySelectorAll('#links tbody tr')],cb=document.getElementById('brokenOnly'),q=document.getElementById('q');
function apply(){const t=q.value.toLowerCase();rows.forEach(r=>{r.style.display=(cb.checked&&r.classList.contains('ok'))||(t&&!r.textContent.toLowerCase().includes(t))?'none':''})}
cb.onchange=apply;q.oninput=apply;
</script></body></html>`;
}

function junitReport(report) {
  const { startUrl, results, durationMs } = report;
  const cases = results.map(r => {
    const name = esc(`${r.status === 0 ? 'ERR' : r.status || '-'} ${r.url}`);
    const time = (r.ms || 0) / 1000;
    const where = esc(`Found on: ${r.foundOn.join(', ')}`);
    if (r.broken) return `  <testcase classname="links.${esc(r.type)}" name="${name}" time="${time}"><failure message="${esc(r.note || 'Broken')}">${where}</failure></testcase>`;
    if (r.unverified) return `  <testcase classname="links.${esc(r.type)}" name="${name}" time="${time}"><skipped message="${esc(r.note || 'Unverified')}"/></testcase>`;
    return `  <testcase classname="links.${esc(r.type)}" name="${name}" time="${time}"/>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="Broken links: ${esc(startUrl)}" tests="${results.length}" failures="${results.filter(r => r.broken).length}" skipped="${results.filter(r => r.unverified).length}" time="${durationMs / 1000}">
${cases}
</testsuite></testsuites>
`;
}

function writeReports(report, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const { config, ...rest } = report;
  const safeConfig = { ...config, login: config.login ? { ...config.login, password: '***' } : null };
  fs.writeFileSync(path.join(outDir, 'report.html'), htmlReport(report));
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ ...rest, config: safeConfig }, null, 2));
  fs.writeFileSync(path.join(outDir, 'junit.xml'), junitReport(report));
  return path.resolve(outDir);
}

module.exports = { writeReports, htmlReport, junitReport };
