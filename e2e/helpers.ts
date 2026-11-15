import { expect, type Page } from '@playwright/test';

export const DEMO_PASSWORD = 'Demo@12345';

/** Collects console errors / uncaught exceptions so specs can assert a clean console. */
export function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Email previews render in <iframe sandbox=""> (scripts intentionally disabled); Chrome logs this when the
    // test driver probes that frame. It reflects the security sandbox working, not an application error.
    if (m.type() === 'error' && !/Failed to load resource|Blocked script execution in 'about:srcdoc'/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** First visit boots the in-browser Postgres and seeds demo data (one-time per browser context). */
export async function bootDemo(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Hire, onboard and pay your people/ })).toBeVisible({ timeout: 120_000 });
}

export async function login(page: Page, email: string, password = DEMO_PASSWORD) {
  await page.goto(`/login`);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/** Client-side navigation (avoids re-booting the in-browser database on every page). */
export async function nav(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, '', p);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

export function localDateTime(minutesFromNow: number) {
  const d = new Date(Date.now() + minutesFromNow * 60000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Minimal valid PDF for upload tests. */
export function samplePdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
  );
}
