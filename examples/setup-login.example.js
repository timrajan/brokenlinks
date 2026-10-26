'use strict';
/**
 * Example custom setup script — use when the built-in form login isn't enough
 * (SSO redirects, a "Next" button between username and password, a cookie banner, etc.).
 *
 *   node src/cli.js --setup examples/setup-login.example.js ...
 *
 * Runs once before crawling, in the same browser. Cookies it creates are used for every
 * page and link check. Read secrets from environment variables, never hard-code them.
 */
module.exports = async (page, { config }) => {
  await page.goto('https://your-app.example.com/login', { waitUntil: 'networkidle2', timeout: config.pageTimeout });

  // Accept a cookie banner if there is one
  const accept = await page.$('button#accept-cookies');
  if (accept) await accept.click();

  // Two-step login: username, Next, then password
  await page.type('#username', process.env.APP_USER);
  await page.click('#next');
  await page.waitForSelector('#password', { visible: true });
  await page.type('#password', process.env.APP_PASSWORD);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('button[type=submit]')]);

  // Fail loudly if login didn't work, rather than crawling the login page
  await page.waitForSelector('nav .user-menu', { timeout: 15000 });
};
