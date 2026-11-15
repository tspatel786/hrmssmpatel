// Mobile layout checks (Pixel 7 viewport): no horizontal overflow, mobile navigation works.
import { expect, test, type Page } from '@playwright/test';
import { bootDemo, login, nav, trackErrors } from './helpers';

async function noHorizontalOverflow(page: Page, label: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `${label}: page scrollWidth ${sw} > viewport ${iw}`).toBeLessThanOrEqual(iw + 1);
}

test('mobile: public pages and app shell render without horizontal overflow', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await bootDemo(page);
  await noHorizontalOverflow(page, 'landing');
  await page.goto('/careers/nimbus');
  await expect(page.getByRole('heading', { name: /Build the future/ })).toBeVisible();
  await noHorizontalOverflow(page, 'careers');
  await page.getByRole('link', { name: /Senior Frontend Engineer/ }).click();
  await expect(page.getByRole('button', { name: 'Submit application' })).toBeVisible();
  await noHorizontalOverflow(page, 'job detail');

  await login(page, 'hr@nimbus.test');
  await noHorizontalOverflow(page, 'dashboard');
  // mobile menu
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Employees' }).click();
  await expect(page.getByRole('heading', { name: 'Employees' })).toBeVisible();
  for (const path of ['/app/employees', '/app/recruitment/candidates', '/app/recruitment/interviews', '/app/leave', '/app/attendance', '/app/payroll', '/app/reports', '/app/communication', '/app/settings']) {
    await nav(page, path);
    await page.waitForTimeout(1200);
    await expect(page.getByText('Could not load data')).toHaveCount(0);
    await noHorizontalOverflow(page, path);
  }
  // chat on mobile: list → conversation → back
  await nav(page, '/app/communication');
  await page.getByRole('button', { name: /Engineering/ }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to conversations' }).click();
  await expect(page.getByTestId('conversation-list')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
