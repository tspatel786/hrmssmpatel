// Daily-use UI checks (demo mode): protected routes, redirect after login, session persistence, sign-out,
// and the role-based dashboard each user lands on (migration 1500 + permission-aware sections).
import { expect, test, type Page } from '@playwright/test';
import { DEMO_PASSWORD, nav, trackErrors } from './helpers';

test.describe.configure({ mode: 'serial' });
let shared: Page;
let errors: string[] = [];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(420_000);
  shared = await (await browser.newContext()).newPage();
  errors = trackErrors(shared);
  await shared.goto('/');
  await expect(shared.getByRole('heading', { name: /Hire, onboard and pay your people/ })).toBeVisible({ timeout: 360_000 });
});
test.afterAll(async () => { await shared?.context().close(); });

async function fillLogin(page: Page, email: string) {
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}
async function loginAs(page: Page, email: string) {
  await nav(page, '/login');
  await fillLogin(page, email);
  await expect(page).toHaveURL(/\/app$/, { timeout: 60_000 });
}

test('protected page redirects to sign-in, then back to the requested page; the session survives a reload', async () => {
  test.setTimeout(240_000);
  const page = shared;
  await nav(page, '/app/leave');
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fleave/);
  await fillLogin(page, 'hr@nimbus.test');
  await expect(page).toHaveURL(/\/app\/leave$/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Leave', level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Leave', level: 1 })).toBeVisible({ timeout: 120_000 });
  await expect(page).toHaveURL(/\/app\/leave$/);
});

test('HR admin dashboard shows every company section from live data', async () => {
  const page = shared;
  await nav(page, '/app');
  const stats = page.getByTestId('company-stats');
  for (const label of ['Headcount', 'Open jobs', 'Present today', 'Pending leave requests', 'Last payroll']) await expect(stats.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByText('Hiring pipeline')).toBeVisible();
});

test('adding an employee sets up their HRMS access automatically (invitation, no separate step)', async () => {
  const page = shared;
  await nav(page, '/app/employees');
  await page.getByRole('button', { name: 'Add employee' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('First name').fill('Ravi');
  await dialog.getByLabel('Last name').fill('Newjoin');
  const email = `ravi.${Date.now()}@nimbus.test`;
  await dialog.getByLabel('Work email').fill(email);
  await dialog.getByRole('button', { name: 'Create employee' }).click();
  await expect(page.getByText(`Employee created · invitation emailed to ${email}`)).toBeVisible({ timeout: 30_000 });
});

test('after sign-out, protected pages require signing in again', async () => {
  const page = shared;
  await signOut(page);
  await nav(page, '/app/payroll');
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fpayroll/);
  await expect(page.getByRole('heading', { name: 'Payroll' })).toHaveCount(0);
});

test('payroll manager dashboard: payroll and attendance, no recruitment funnel', async () => {
  const page = shared;
  await loginAs(page, 'payroll@nimbus.test');
  const stats = page.getByTestId('company-stats');
  await expect(stats.getByText('Last payroll', { exact: true })).toBeVisible();
  await expect(stats.getByText('Present today', { exact: true })).toBeVisible();
  await expect(stats.getByText('Open jobs', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Hiring pipeline')).toHaveCount(0);
  await signOut(page);
});

test('hiring manager dashboard: recruitment + "My team" for direct reports, never company payroll; team attendance tab', async () => {
  const page = shared;
  await loginAs(page, 'manager@nimbus.test');
  await expect(page.getByText(/^My team \(\d+\)$/)).toBeVisible();
  await expect(page.getByTestId('team-members').locator('li').first()).toBeVisible();
  const stats = page.getByTestId('company-stats');
  await expect(stats.getByText('Open jobs', { exact: true })).toBeVisible();
  await expect(stats.getByText('Last payroll', { exact: true })).toHaveCount(0);
  await nav(page, '/app/attendance?tab=team');
  await expect(page.getByRole('tab', { name: 'My team' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Could not load data')).toHaveCount(0);
  await signOut(page);
});

test('employee dashboard: self-service only, no company statistics', async () => {
  const page = shared;
  await loginAs(page, 'employee@nimbus.test');
  await expect(page.getByText('Leave balance')).toBeVisible();
  await expect(page.getByTestId('company-stats')).toHaveCount(0);
  await expect(page.getByText('Last payroll')).toHaveCount(0);
  await signOut(page);
  expect(errors, errors.join('\n')).toEqual([]);
});
