// Role-based access in the UI + navigation smoke test of every sidebar page.
import { expect, test } from '@playwright/test';
import { bootDemo, login, nav, trackErrors } from './helpers';

test('employee: self-service only — admin pages hidden and blocked', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await bootDemo(page);
  await login(page, 'employee@nimbus.test');
  const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
  for (const hidden of ['Payroll', 'Employees', 'Candidates', 'Settings', 'Audit Logs', 'Reports']) {
    await expect(sidebar.getByRole('link', { name: hidden, exact: true })).toHaveCount(0);
  }
  for (const visible of ['Attendance', 'Leave', 'My Payslips', 'Communication']) await expect(sidebar.getByRole('link', { name: new RegExp(visible) })).toBeVisible();
  await nav(page, '/app/payroll');
  await expect(page.getByRole('heading', { name: "You don't have access to this page" })).toBeVisible();
  await nav(page, '/app/settings');
  await expect(page.getByRole('heading', { name: "You don't have access to this page" })).toBeVisible();

  // clock in from the dashboard
  await nav(page, '/app');
  await page.getByRole('button', { name: 'Clock in' }).first().click();
  await expect(page.getByText('Clocked in. Have a great day!')).toBeVisible();
  // payslips from the processed payroll
  await nav(page, '/app/payroll/my-payslips');
  await expect(page.getByRole('button', { name: 'Download PDF' }).first()).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('HR admin: every sidebar page loads without errors', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await bootDemo(page);
  await login(page, 'hr@nimbus.test');
  const links = await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('href')!));
  expect(links.length).toBeGreaterThan(18);
  for (const href of links) {
    await nav(page, href);
    await expect(page.getByRole('heading', { level: 1 }).or(page.getByRole('heading', { name: 'Team communication' })).or(page.getByText('SaaS super admin')).first()).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.getByText('Could not load data'), href).toHaveCount(0);
    await expect(page.getByText('Page not found'), href).toHaveCount(0);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('payroll manager can run payroll; recruiter cannot see it', async ({ page }) => {
  test.setTimeout(240_000);
  await bootDemo(page);
  await login(page, 'recruiter@nimbus.test');
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Payroll', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await login(page, 'payroll@nimbus.test');
  await nav(page, '/app/payroll');
  await page.getByRole('button', { name: 'Run payroll' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Month').selectOption(String(new Date().getMonth() + 1));
  await d.getByLabel('Year').selectOption(String(new Date().getFullYear()));
  await d.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByText('Payroll generated as draft')).toBeVisible();
  await expect(page.getByRole('cell', { name: /Sneha Patil/ })).toBeVisible();
  await page.getByRole('button', { name: 'Payslip' }).first().click(); // PDF download
});
