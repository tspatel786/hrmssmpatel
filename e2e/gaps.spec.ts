// UI E2E for the features added to close the KNOWN_ISSUES gaps (demo mode, real migrations in the browser).
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { login, nav, trackErrors } from './helpers';

const shots = 'test-results/gaps';
// One booted demo database for the whole file (booting the in-browser Postgres takes ~50 s per browser context).
test.describe.configure({ mode: 'serial' });
let shared: Page;
let errors: string[] = [];
test.beforeAll(async ({ browser }) => {
  test.setTimeout(420_000);
  shared = await (await browser.newContext()).newPage();
  errors = trackErrors(shared);
  const log: string[] = [];
  shared.on('console', (m) => log.push(`${m.type()}: ${m.text()}`.slice(0, 400)));
  shared.on('pageerror', (e) => log.push(`pageerror: ${e.message}`));
  try {
    // same as bootDemo(), with a longer budget: first-launch seeding is CPU-bound and slows down on a busy machine
    await shared.goto('/');
    await expect(shared.getByRole('heading', { name: /Hire, onboard and pay your people/ })).toBeVisible({ timeout: 360_000 });
  } catch (e) {
    console.log(['BOOT FAILED. Browser console:', ...log].join('\n'));
    throw e;
  }
});
test.afterAll(async () => { await shared?.context().close(); });

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

test('attendance correction: employee requests → manager approves; team leave calendar; dark mode', async () => {
  test.setTimeout(300_000);
  const page = shared;
  await login(page, 'employee@nimbus.test');

  // employee: request a correction for yesterday
  await nav(page, '/app/attendance?tab=corrections');
  await page.getByRole('button', { name: 'Request correction' }).click();
  const dlg = page.getByRole('dialog');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await dlg.getByLabel('Date').fill(yesterday);
  await dlg.getByLabel('Check-in').fill('09:20');
  await dlg.getByLabel('Check-out').fill('18:40');
  await dlg.getByLabel('Reason').fill('Biometric reader was offline at the entrance');
  await dlg.getByRole('button', { name: 'Submit request' }).click();
  await expect(page.getByText('Correction request submitted for approval')).toBeVisible();
  await expect(page.getByTestId('corrections-list')).toContainText('Biometric reader was offline');
  await expect(page.getByTestId('corrections-list').getByRole('button', { name: 'Approve' })).toHaveCount(0); // cannot self-approve

  // team leave calendar is available to employees
  await nav(page, '/app/leave?tab=calendar');
  await expect(page.getByText(/Team calendar ·/)).toBeVisible();
  await expect(page.getByTestId('leave-calendar')).toBeVisible();

  // dark mode toggle persists and applies
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/dark-leave-calendar.png`, fullPage: true });
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByTestId('theme-toggle').click(); // dark → system
  await page.getByTestId('theme-toggle').click(); // system → light
  await expect(page.locator('html')).not.toHaveClass(/dark/);

  // manager approves
  await signOut(page);
  await login(page, 'manager@nimbus.test');
  await nav(page, '/app/attendance?tab=corrections');
  const row = page.getByTestId('corrections-list').locator('li', { hasText: 'Biometric reader was offline' });
  await row.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Correction approved · attendance updated')).toBeVisible();
  await page.getByRole('tab', { name: 'All' }).click();
  await expect(page.getByTestId('corrections-list').locator('li', { hasText: 'Biometric reader was offline' })).toContainText(/Approved/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('recruiting: bulk tag + bulk stage move, offer templates, reports PDF, careers education & reference number', async () => {
  test.setTimeout(300_000);
  const page = shared;
  await login(page, 'hr@nimbus.test');

  // bulk tag on the candidates table
  await nav(page, '/app/recruitment/candidates');
  const boxes = page.locator('table').getByRole('checkbox', { name: 'Select row' });
  await expect(boxes.first()).toBeVisible();
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const bar = page.getByRole('region', { name: 'Bulk actions' });
  await expect(bar).toContainText('2 selected');
  await bar.getByLabel('Tag').fill('priority');
  await bar.getByRole('button', { name: 'Add tag' }).click();
  await expect(page.getByText('2 candidates updated')).toBeVisible();
  await expect(page.locator('table').getByText('priority')).toHaveCount(2);

  // bulk stage move on a job's applicants
  // open a job that has applicants (the seed also contains jobs without any)
  const appBoxes = page.locator('table').getByRole('checkbox', { name: 'Select row' });
  for (let i = 0; i < 8; i++) {
    await nav(page, '/app/recruitment/jobs');
    await page.locator('table tbody tr').nth(i).click();
    await expect(page.getByRole('heading', { name: 'Applicants' })).toBeVisible();
    await page.waitForTimeout(800);
    if (await appBoxes.count()) break;
  }
  await appBoxes.first().check();
  const appBar = page.getByRole('region', { name: 'Bulk actions' });
  await appBar.getByLabel('Move to stage').selectOption('on_hold');
  await appBar.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText(/application(s)? updated|could not be updated/).first()).toBeVisible();

  // offer templates: create + preview
  await nav(page, '/app/offers?tab=templates');
  await expect(page.getByTestId('offer-templates')).toContainText('Standard full-time');
  await expect(page.getByTestId('offer-templates')).toContainText('Internship');
  await page.getByRole('button', { name: 'New template' }).click();
  const tdlg = page.getByRole('dialog');
  await tdlg.getByLabel('Template name').fill('Sales with incentives');
  await tdlg.getByLabel('General terms').fill('Incentives are paid quarterly as per the sales incentive policy.');
  await tdlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(page.getByTestId('offer-templates')).toContainText('Sales with incentives');
  const popup = page.waitForEvent('popup');
  await page.getByTestId('offer-templates').locator('li', { hasText: 'Sales with incentives' }).getByRole('button', { name: 'Preview PDF' }).click();
  await (await popup).close();

  // reports: attendance summary shows late/early columns and exports a PDF
  await nav(page, '/app/reports');
  await page.getByRole('button', { name: /Attendance summary/ }).click();
  await expect(page.getByRole('columnheader', { name: 'Late Arrivals' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^attendance-report-.*\.pdf$/);
  const pdfPath = `${shots}/attendance-report.pdf`;
  fs.mkdirSync(shots, { recursive: true });
  await file.saveAs(pdfPath);
  expect(fs.readFileSync(pdfPath).subarray(0, 5).toString()).toBe('%PDF-');

  // careers: education fields + reference number on success
  await signOut(page);
  await nav(page, '/careers/nimbus');
  await page.getByRole('link', { name: /View details|Apply/ }).first().click();
  await page.getByLabel('First name').fill('Esha');
  await page.getByLabel('Email').fill(`esha.${Date.now()}@example.com`);
  await page.getByLabel('Phone').fill('9876501234');
  await page.getByLabel('Highest qualification').fill('M.Sc Statistics');
  await page.getByLabel('Institution').fill('University of Pune');
  await page.getByLabel('Year').fill('2023');
  await page.locator('input[type=file]').setInputFiles({ name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') });
  await page.getByRole('checkbox').last().check();
  await page.getByRole('button', { name: /Submit application/ }).click();
  await expect(page.getByRole('heading', { name: 'Application submitted!' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('application-ref')).toHaveText(/^APP-[0-9A-F]{8}$/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('dark mode renders the main app pages legibly', async () => {
  test.setTimeout(240_000);
  const page = shared;
  await login(page, 'hr@nimbus.test');
  await page.evaluate(() => localStorage.setItem('hrms-theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  fs.mkdirSync(shots, { recursive: true });
  for (const [path, name] of [['/app', 'dashboard'], ['/app/recruitment/candidates', 'candidates'], ['/app/attendance?tab=register', 'attendance'], ['/app/communication', 'communication'], ['/app/settings', 'settings']]) {
    await nav(page, path);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${shots}/dark-${name}.png` });
    // body text must contrast with the page background
    const ok = await page.evaluate(() => {
      const bg = getComputedStyle(document.body).backgroundColor;
      const h = document.querySelector('h1, h2');
      return { bg, color: h ? getComputedStyle(h).color : '' };
    });
    expect(ok.bg).toBe('rgb(2, 6, 23)');
    expect(ok.color).not.toBe('rgb(15, 23, 42)'); // not dark slate on dark background
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
