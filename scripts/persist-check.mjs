// Reproduces: write via RPC, then full reload — does the write survive in IndexedDB?
import { chromium } from '@playwright/test';
const waitMs = Number(process.argv[2] ?? 0);
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:4173/');
await page.waitForSelector('text=Hire, onboard', { timeout: 180000 });
// count applications as HR before
async function count() {
  await page.goto('http://localhost:4173/login?email=hr@nimbus.test');
  await page.click('button[type=submit]');
  await page.waitForURL('**/app');
  await page.evaluate(() => { history.pushState({}, '', '/app/recruitment/candidates'); dispatchEvent(new PopStateEvent('popstate')); });
  const loc = page.locator('div', { hasText: /^\d+–\d+ of \d+/ }).last();
  await page.waitForFunction(() => /\d+–\d+ of \d+/.test(document.body.innerText), null, { timeout: 30000 });
  const t = (await page.evaluate(() => document.body.innerText.match(/\d+–\d+ of \d+/)?.[0])) ?? '?';
  void loc;
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  return t;
}
console.log('before:', await count());
await page.goto('http://localhost:4173/careers/nimbus');
await page.getByRole('link', { name: /Backend Engineer/ }).click();
await page.getByLabel('First name').fill('Persist');
await page.locator('#em').fill(`persist${Date.now()}@example.com`);
await page.getByLabel('Phone').fill('9999999999');
await page.locator('input[type=file]').setInputFiles({ name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') });
await page.getByLabel(/I consent/).check();
await page.getByRole('button', { name: 'Submit application' }).click();
await page.waitForSelector('text=Application submitted!');
await page.waitForTimeout(waitMs);
console.log(`after (waited ${waitMs}ms):`, await count());
await browser.close();
