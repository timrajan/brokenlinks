'use strict';
/**
 * Builds the run configuration from (lowest to highest priority):
 *   defaults  <  config file (--config, JSON)  <  command-line flags
 * "${ENV_VAR}" inside any config-file string is replaced with that environment variable,
 * so secrets (passwords) can come from pipeline secret variables.
 */
const fs = require('fs');
const path = require('path');

/**
 * The four run-time inputs have NO defaults — they must come from the pipeline (or the
 * command line / environment). See REQUIRED below.
 */
const REQUIRED = {
  url:        { flag: '--url',         env: 'LINKCHECK_URL',         desc: 'start URL' },
  depth:      { flag: '--depth',       env: 'LINKCHECK_DEPTH',       desc: 'how many clicks deep to follow links (0 = start page only)' },
  maxBroken:  { flag: '--max-broken',  env: 'LINKCHECK_MAX_BROKEN',  desc: 'stop the check once this many broken links are found' },
  timeoutSec: { flag: '--timeout',     env: 'LINKCHECK_TIMEOUT_SEC', desc: 'seconds a page/link may take to load before it fails' },
};

const DEFAULTS = {
  maxPages: 500,            // safety cap on pages opened in the browser
  scope: '',                // only crawl URLs starting with this text
  exclude: 'logout|log-out|signout|sign-out|logoff|delete|remove|destroy|unsubscribe',
  internalOnly: false,      // skip checking links to other sites
  checkLastLevelPages: true,// open same-site pages at the last level to catch "not found" screens
  checkResources: true,     // record images/scripts/API calls that fail while a page loads
  ignoreResourceTypes: [],  // e.g. ["xhr", "fetch"] to ignore failing API calls
  notFoundText: '\\b(404|page not found|not found|does not exist|no longer exists|no longer available)\\b',
  loginUrlPattern: 'login|signin|sign-in|logon|auth',
  concurrency: 4,           // browser tabs open at once
  linkConcurrency: 10,      // parallel HTTP checks for non-page links
  settleMs: 800,            // page counts as drawn after this long with no DOM changes
  out: 'link-report',
  screenshots: true,        // screenshot pages that are broken / show "not found"
  headful: false,           // show the browser window
  chrome: '',               // Chrome/Edge executable (else Puppeteer's own Chrome)
  failOnBroken: false,
  setup: '',                // path to a JS module run before crawling, e.g. custom login
  login: null,              // built-in form login, see README
  viewport: { width: 1366, height: 900 },
};

const USAGE = `
Usage: node src/cli.js --url <url> --depth <n> --max-broken <n> --timeout <seconds> [options]

Required (flag, or environment variable):
  --url <url>              LINKCHECK_URL          Start URL
  --depth <n>              LINKCHECK_DEPTH        Clicks deep to follow links (0 = start page only)
  --max-broken <n>         LINKCHECK_MAX_BROKEN   Stop the check once this many broken links are found
  --timeout <seconds>      LINKCHECK_TIMEOUT_SEC  A page or link that takes longer than this to load fails

Optional:
  --max-pages <n>          Safety cap on pages opened in the browser (default 500)
  --scope <text>           Only crawl URLs that start with this text
  --exclude <regex>        Never open/check URLs matching this (default: logout|delete|...)
  --internal-only          Don't check links to other sites
  --concurrency <n>        Browser tabs at once (default 4)
  --settle <ms>            Quiet time before a page counts as drawn (default 800)
  --out <dir>              Report folder (default ./link-report)
  --config <file>          JSON config file (see link-checker.config.example.json)
  --setup <file>           JS module run before crawling (custom login etc.)
  --chrome <path>          Use this Chrome/Edge instead of Puppeteer's bundled Chrome
  --headful                Show the browser window
  --no-screenshots         Don't screenshot broken pages
  --no-resources           Don't report images/scripts/API calls that fail while pages load
  --fail-on-broken         Exit code 1 if anything is broken (fails the pipeline step)
`;

function substituteEnv(value) {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '');
  if (Array.isArray(value)) return value.map(substituteEnv);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v)]));
  return value;
}

function parseArgs(argv) {
  const flags = {};
  const num = (k, v) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${k} needs a number, got "${v}"`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    switch (a) {
      case '--url': flags.url = next(); break;
      case '--depth': flags.depth = num(a, next()); break;
      case '--max-broken': flags.maxBroken = num(a, next()); break;
      case '--timeout': flags.timeoutSec = num(a, next()); break;
      case '--max-pages': flags.maxPages = num(a, next()); break;
      case '--scope': flags.scope = next(); break;
      case '--exclude': flags.exclude = next(); break;
      case '--internal-only': flags.internalOnly = true; break;
      case '--concurrency': flags.concurrency = num(a, next()); break;
      case '--link-concurrency': flags.linkConcurrency = num(a, next()); break;
      case '--settle': flags.settleMs = num(a, next()); break;
      case '--out': flags.out = next(); break;
      case '--config': flags.config = next(); break;
      case '--setup': flags.setup = next(); break;
      case '--chrome': flags.chrome = next(); break;
      case '--headful': flags.headful = true; break;
      case '--no-screenshots': flags.screenshots = false; break;
      case '--no-resources': flags.checkResources = false; break;
      case '--fail-on-broken': flags.failOnBroken = true; break;
      case '-h': case '--help': flags.help = true; break;
      default:
        if (/^https?:\/\//i.test(a)) flags.url = a;
        else throw new Error(`Unknown option: ${a}`);
    }
  }
  return flags;
}

function loadConfig(argv) {
  const flags = parseArgs(argv);
  if (flags.help) return { help: true, usage: USAGE };
  let fileCfg = {};
  if (flags.config) {
    const p = path.resolve(flags.config);
    fileCfg = substituteEnv(JSON.parse(fs.readFileSync(p, 'utf8')));
    if (fileCfg.setup) fileCfg.setup = path.resolve(path.dirname(p), fileCfg.setup);
    // The four run-time inputs must come from the pipeline / command line, never a file in the repo
    for (const k of Object.keys(REQUIRED)) {
      if (k in fileCfg) { console.warn(`Ignoring "${k}" in ${flags.config} — pass it at run time (${REQUIRED[k].flag} or ${REQUIRED[k].env}).`); delete fileCfg[k]; }
    }
    delete fileCfg._comment;
  }
  const fromEnv = {};
  for (const [key, r] of Object.entries(REQUIRED)) {
    const v = process.env[r.env];
    if (v !== undefined && v !== '') fromEnv[key] = key === 'url' ? v : Number(v);
  }
  const cfg = { ...DEFAULTS, ...fileCfg, ...fromEnv, ...flags };
  delete cfg.config;
  return normalize(cfg);
}

function normalize(cfg) {
  cfg = { ...DEFAULTS, ...cfg };
  const missing = Object.entries(REQUIRED).filter(([k]) => cfg[k] === undefined || cfg[k] === null || cfg[k] === '' || (k !== 'url' && !Number.isFinite(Number(cfg[k]))));
  if (missing.length) {
    throw new Error('Missing required input(s):\n' + missing.map(([, r]) => `  ${r.flag.padEnd(14)} or env ${r.env.padEnd(22)} ${r.desc}`).join('\n') + '\n' + USAGE);
  }
  if (!/^https?:\/\//i.test(cfg.url)) throw new Error(`url must start with http:// or https:// (got "${cfg.url}")`);
  cfg.depth = Math.floor(Number(cfg.depth));
  cfg.maxBroken = Math.floor(Number(cfg.maxBroken));
  cfg.timeoutSec = Number(cfg.timeoutSec);
  if (cfg.depth < 0) throw new Error('depth must be 0 or more');
  if (cfg.maxBroken < 1) throw new Error('maxBroken must be 1 or more');
  if (cfg.timeoutSec <= 0) throw new Error('timeout must be more than 0 seconds');
  cfg.pageTimeout = Math.round(cfg.timeoutSec * 1000);     // page load in the browser
  cfg.requestTimeout = cfg.pageTimeout;                    // HTTP check of files / external links
  cfg.chrome = cfg.chrome || process.env.CHROME_PATH || '';
  if (cfg.setup) cfg.setup = path.resolve(cfg.setup);
  return cfg;
}

module.exports = { loadConfig, normalize, DEFAULTS, REQUIRED, USAGE };
