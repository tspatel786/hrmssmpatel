// Resignation & exit and document management in the browser (demo mode, migration 2000):
// employee resigns + uploads a document -> reporting manager approves -> HR approves, completes checklist, settlement,
// relieving letter and exit; HR verifies the document; dashboards show the new cards.
import { expect, test, type Page } from '@playwright/test';
import { DEMO_PASSWORD, nav, samplePdf, trackErrors } from './helpers';

test.describe.configure({ mode: 'serial' });
let page: Page;
let errors: string[] = [];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(420_000);
  page = await (await browser.newContext()).newPage();
  errors = trackErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Hire, onboard and pay your people/ })).toBeVisible({ timeout: 360_000 });
});
test.afterAll(async () => { await page?.context().close(); });

async function loginAs(email: string) {
  await nav(page, '/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 60_000 });
}
async function signOut() {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

test('employee submits a resignation and uploads a document', async () => {
  test.setTimeout(240_000);
  await loginAs('employee@nimbus.test');
  await expect(page.getByTestId('my-workspace')).toBeVisible();
  await nav(page, '/app/exits');
  await page.getByRole('button', { name: 'Submit resignation' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Reason for resigning').fill('Relocating to Bengaluru to be closer to family.');
  await dlg.getByRole('button', { name: 'Submit resignation' }).click();
  await expect(page).toHaveURL(/\/app\/exits\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Waiting for manager').first()).toBeVisible();

  await nav(page, '/app/documents');
  await page.getByLabel('Document file').setInputFiles({ name: 'aadhaar.pdf', mimeType: 'application/pdf', buffer: samplePdf() });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByTestId('my-documents')).toContainText('aadhaar.pdf');
  await expect(page.getByTestId('my-documents')).toContainText('Awaiting verification');
  await signOut();
});

test('reporting manager approves', async () => {
  test.setTimeout(180_000);
  await loginAs('manager@nimbus.test');
  await nav(page, '/app/exits?tab=team');
  await page.getByTestId('resignation-list').getByRole('link', { name: /Sneha Patil/ }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Waiting for HR').first()).toBeVisible();
  await signOut();
});

test('HR approves, completes checklist and settlement, issues the relieving letter and completes the exit; verifies the document', async () => {
  test.setTimeout(300_000);
  await loginAs('hr@nimbus.test');
  await expect(page.getByTestId('hr-overview')).toContainText('Pending resignations');
  await nav(page, '/app/exits?tab=pending');
  await page.getByTestId('resignation-list').getByRole('link', { name: /Sneha Patil/ }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Approve & start notice' }).click();
  await expect(page.getByText('Serving notice').first()).toBeVisible();

  const list = page.getByTestId('exit-checklist');
  await expect(list.getByRole('checkbox')).toHaveCount(6);
  for (let i = 0; i < 6; i++) {
    const box = list.getByRole('checkbox').nth(i);
    await box.check();
    await expect(box).toBeChecked();
  }
  await page.getByRole('button', { name: 'Update' }).click();
  await page.getByRole('dialog').getByRole('combobox').selectOption('paid');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settlement saved')).toBeVisible();
  await page.getByRole('button', { name: 'Relieving letter' }).click();
  await expect(page.getByText('Letter saved to documents and emailed')).toBeVisible();
  await page.getByRole('button', { name: 'Complete exit' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Complete exit' }).click();
  await expect(page.getByText('Exit completed').first()).toBeVisible();

  await nav(page, '/app/documents?tab=verify');
  const pending = page.getByTestId('documents-verify');
  await expect(pending).toContainText('aadhaar.pdf');
  await pending.getByRole('button', { name: 'Verify' }).first().click();
  await expect(page.getByText('Saved · employee notified')).toBeVisible();
  await nav(page, '/app/reports');
  await page.getByRole('button', { name: /Employee exits/ }).click();
  await expect(page.getByText('Sneha Patil').first()).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
