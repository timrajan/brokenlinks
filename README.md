# Broken Link Checker (Puppeteer)

Finds broken links on a website or web app by opening pages in a real (headless) Chrome,
waiting for the app to draw, reading the links, and following them to the depth you choose.

It handles:

- **Single-page apps** (Angular / React / Vue), including `#/route` addresses and links drawn by JavaScript.
- **"Page not found" screens.** In these apps every page loads "successfully", so it reads the page and flags titles or headings like *404* / *not found*. It saves a screenshot of each one.
- **Resources that fail while a page loads**, such as images, scripts and API calls returning 4xx/5xx. These are captured from the browser's network traffic.
- **Files and external sites**, checked with HTTP requests. External links get real status codes, with no browser CORS limits.
- **Pages behind a login**, via a built-in form login or your own setup script.

## The four run-time inputs

These have **no defaults anywhere in the project**. They must be given each run.

| Input | Flag | Environment variable | Meaning |
|---|---|---|---|
| URL | `--url` | `LINKCHECK_URL` | Page to start from |
| Depth | `--depth` | `LINKCHECK_DEPTH` | How many clicks deep to follow links. `0` checks the start page's links only. `1` also opens every page those links lead to, and so on. |
| Max broken | `--max-broken` | `LINKCHECK_MAX_BROKEN` | Stop once this many broken links are found. The run then fails. |
| Timeout | `--timeout` | `LINKCHECK_TIMEOUT_SEC` | Seconds a page or link may take to load. Slower than this counts as broken. |

If any of the four is missing, the run stops before opening a browser and lists what's missing (exit code 2).

## Quick start (your machine)

```bash
npm install            # also downloads the Chrome that Puppeteer drives (~150 MB)
npm test               # self-test against a built-in mock site — should say 11/11 passed

node src/cli.js --url "https://your-app/#/orders" --depth 3 --max-broken 100 --timeout 100
```

Add `--headful` to watch the browser work. Reports are written to `./link-report/`:

| File | What it is |
|---|---|
| `report.html` | Open in a browser. It has a summary, a "show broken only" filter, a search box, the page each link was found on, and screenshots. |
| `report.json` | All results, for further processing |
| `junit.xml` | One test per link. Broken links are failures and unverified ones are skipped. Azure DevOps shows it in the **Tests** tab. |
| `screenshots/` | Screenshots of broken / not-found pages |

## Azure Pipelines

1. Commit this folder to a repo, including `package-lock.json`.
2. Create a pipeline from `azure-pipelines.yml`.
3. Click **Run pipeline** and fill in the four boxes: URL, depth, max broken links and timeout.

The pipeline then:

- shows progress in the build log;
- puts the result of each link in the **Tests** tab;
- publishes `report.html` and screenshots in the **link-report** artifact;
- sets a `BrokenLinkCount` variable for later steps.

The step fails when any broken link is found (`--fail-on-broken`) or when the max-broken limit is reached. To get a report without failing the build, remove `--fail-on-broken`; reaching the limit still fails it.

**Build agent notes**
- Requires Node 18 or newer.
- Microsoft-hosted agents work as is.
- **Self-hosted Linux** agents need Chrome's system libraries. Running `npx puppeteer browsers install chrome --install-deps` as root installs them.
- **No internet for the Chrome download?** Set `PUPPETEER_SKIP_DOWNLOAD=true` for `npm ci`, and point `CHROME_PATH` at an installed Chrome or Edge.
- **Corporate proxy:** set `HTTPS_PROXY` for `npm ci` so the install can download packages and Chrome.

## Optional settings

Copy `link-checker.config.example.json` to `link-checker.config.json`, then pass `--config link-checker.config.json`.
The four run-time inputs are ignored if put in this file.

| Setting | Default | |
|---|---|---|
| `maxPages` | 500 | Safety cap on pages opened. Anything beyond it is listed as unverified. |
| `concurrency` | 4 | Browser tabs at once |
| `scope` | | Only crawl URLs starting with this, e.g. `https://app/#/orders` |
| `exclude` | logout, delete, ... | Regex of URLs never opened or checked, so it doesn't sign you out or change data |
| `internalOnly` | false | Skip links to other sites |
| `ignoreResourceTypes` | [] | e.g. `["xhr","fetch"]` to ignore failing API calls |
| `settleMs` | 800 | Quiet time before a page counts as drawn. Raise it for slow apps. |
| `screenshots` | true | Screenshot broken pages |

## Login

**Simple form login.** Add a `login` section to the config file. `${APP_USER}` and `${APP_PASSWORD}` come from environment variables. In the pipeline, make them **secret variables** and map them in the step's `env:`.

```json
"login": {
  "url": "https://your-app/login",
  "username": "${APP_USER}",
  "password": "${APP_PASSWORD}",
  "usernameSelector": "#username",
  "passwordSelector": "#password",
  "submitSelector": "button[type=submit]",
  "successSelector": "nav .user-menu"
}
```

**Anything more complex** (SSO, two-step, cookie banners): write a setup script and pass `--setup my-login.js`.
See `examples/setup-login.example.js`.

Without a login, protected pages show as **unverified: "Redirected to login"**. They aren't reported as broken.

## Using it from code (e.g. your Jest/Puppeteer framework)

```js
const { runLinkCheck } = require('./src');
const { writeReports } = require('./src/reports');

const report = await runLinkCheck({ url, depth: 3, maxBroken: 100, timeoutSec: 100 });
writeReports(report, 'link-report');
expect(report.summary.broken).toBe(0);
```

## What "broken" and "unverified" mean

- **Broken (✗):**
  - an HTTP 4xx/5xx response;
  - a connection error;
  - slower than the timeout;
  - a page showing "not found";
  - a resource that failed while a page loaded.
- **Unverified (?):**
  - redirected to login;
  - an external site refusing automated checks (401/403/429), which you should check manually;
  - not reached because of `maxPages`, the depth limit (app routes), or the max-broken stop.

## Limits

- Menu items that are buttons running code (with no link address) can't be followed. Only real links are crawled.
- "Not found" detection is by text, so review those rows. A page that legitimately says "not found" would be flagged.
- When max-broken is reached, tabs already in progress finish first, so the count can go slightly over the limit.
