'use strict';
/**
 * Signs in before crawling. Two ways:
 *
 * 1. Built-in form login (config file "login" section):
 *    {
 *      "url": "https://myapp/login",
 *      "username": "${APP_USER}",            <- from environment / pipeline secret variables
 *      "password": "${APP_PASSWORD}",
 *      "usernameSelector": "#username",
 *      "passwordSelector": "#password",
 *      "submitSelector": "button[type=submit]",
 *      "successSelector": "nav .user-menu"   <- optional: element that only appears once signed in
 *    }
 *
 * 2. Your own script (--setup ./my-login.js) for SSO, MFA bypass tokens, multi-step forms...
 *      module.exports = async (page, { browser, config }) => { ...sign in with page... };
 *
 * Cookies set during login stay in the browser and are used for every page and HTTP check.
 */

async function runLogin(browser, config, log) {
  if (!config.login && !config.setup) return;
  const page = await browser.newPage();
  await page.setViewport(config.viewport);
  try {
    if (config.login) {
      const l = config.login;
      for (const k of ['url', 'usernameSelector', 'passwordSelector']) if (!l[k]) throw new Error(`login.${k} is required`);
      if (!l.username || !l.password) throw new Error('login.username / login.password are empty — are the environment variables set?');
      log(`Signing in at ${l.url} ...`);
      await page.goto(l.url, { waitUntil: 'networkidle2', timeout: config.pageTimeout });
      await page.waitForSelector(l.usernameSelector, { visible: true, timeout: config.pageTimeout });
      await page.type(l.usernameSelector, l.username);
      await page.type(l.passwordSelector, l.password);
      const submit = l.submitSelector
        ? page.click(l.submitSelector)
        : page.keyboard.press('Enter');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: config.pageTimeout }).catch(() => {}),
        submit,
      ]);
      if (l.successSelector) {
        await page.waitForSelector(l.successSelector, { timeout: config.pageTimeout })
          .catch(() => { throw new Error(`Login failed: "${l.successSelector}" did not appear (now on ${page.url()})`); });
      } else if (await page.$(l.passwordSelector)) {
        throw new Error(`Login failed: still on a page with the password field (${page.url()})`);
      }
      log(`Signed in (now on ${page.url()})`);
    }
    if (config.setup) {
      log(`Running setup script ${config.setup} ...`);
      const setup = require(config.setup);
      await (setup.default || setup)(page, { browser, config });
    }
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { runLogin };
