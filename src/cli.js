#!/usr/bin/env node
'use strict';
const { loadConfig } = require('./config');
const { runLinkCheck } = require('./index');
const { writeReports } = require('./reports');

(async () => {
  let cfg;
  try {
    cfg = loadConfig(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (cfg.help) { console.log(cfg.usage); return; }

  console.log(`Start: ${cfg.url}`);
  console.log(`Depth: ${cfg.depth} | Max broken links: ${cfg.maxBroken} | Timeout: ${cfg.timeoutSec}s | Max pages: ${cfg.maxPages}`);
  const report = await runLinkCheck(cfg);
  const dir = writeReports(report, cfg.out);
  const { summary, results } = report;

  const broken = results.filter(r => r.broken);
  if (broken.length) {
    console.log('\nBroken:');
    for (const b of broken) {
      console.log(`  ${String(b.status === 0 ? 'ERR' : b.status).padEnd(4)} ${b.url}`);
      console.log(`       ${b.note}`);
      console.log(`       found on: ${b.foundOn.join(', ')}`);
    }
  }
  console.log(`\nPages scanned: ${summary.pagesScanned}  Links: ${summary.total}  Broken: ${summary.broken}  Unverified: ${summary.unverified}  OK: ${summary.ok}`);
  console.log(`Reports: ${dir}`);
  if (summary.stoppedEarly) console.log(`\n⛔ Stopped early: reached the maximum of ${summary.maxBroken} broken links. Links not reached are marked "Not checked".`);

  // Azure DevOps logging commands
  if (process.env.TF_BUILD) {
    console.log(`##vso[task.setvariable variable=BrokenLinkCount]${summary.broken}`);
    if (summary.stoppedEarly) console.log(`##vso[task.logissue type=error]Stopped after reaching max broken links (${summary.maxBroken})`);
    else if (summary.broken) console.log(`##vso[task.logissue type=warning]${summary.broken} broken link(s) across ${summary.pagesScanned} page(s) — see the link-report artifact`);
  }
  // Reaching the max-broken limit always fails the run; any broken link fails it with --fail-on-broken
  process.exitCode = summary.stoppedEarly || (cfg.failOnBroken && summary.broken) ? 1 : 0;
})().catch(e => {
  console.error(`\nLink check failed: ${e.message}`);
  if (process.env.TF_BUILD) console.log(`##vso[task.logissue type=error]Link check failed: ${e.message}`);
  process.exit(1);
});
