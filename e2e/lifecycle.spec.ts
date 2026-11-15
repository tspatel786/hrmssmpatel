// Full hiring lifecycle driven through the real UI (demo mode, mock email):
// signup → company → job → careers application → shortlist → interview → feedback →
// select → offer → approval → send → secure acceptance → onboarding → employee.
import { expect, test } from '@playwright/test';
import { bootDemo, localDateTime, nav, samplePdf, trackErrors } from './helpers';

test.describe.configure({ mode: 'serial' });

test('complete hiring lifecycle through the UI', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = trackErrors(page);
  await bootDemo(page);

  // 1-2. Create an HR user + company
  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Quinn QA');
  await page.getByLabel('Work email').fill('quinn@acme-qa.test');
  await page.getByLabel('Password', { exact: true }).fill('Secure123');
  await page.getByLabel('Confirm password').fill('Secure123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding\/company/);
  await page.getByLabel('Company name').fill('Acme QA');
  await expect(page.getByLabel('Careers page URL')).toHaveValue('acme-qa');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText("Here's what's happening at Acme QA today.")).toBeVisible();

  // 3. Create and publish a job
  await nav(page, '/app/recruitment/jobs');
  await page.getByRole('button', { name: 'New job' }).click();
  await page.getByRole('dialog').getByLabel('Job title').fill('QA Automation Engineer');
  await page.getByRole('dialog').getByLabel('Status').selectOption('published');
  await page.getByRole('dialog').getByLabel('About the role').fill('Own end-to-end test automation for our HR platform.');
  await page.getByRole('button', { name: 'Create job' }).click();
  await expect(page.getByRole('heading', { name: /QA Automation Engineer/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Careers link' })).toBeVisible();

  // 4-5. Public careers page + application with resume (no account needed)
  await page.goto('/careers/acme-qa');
  await page.getByRole('link', { name: /QA Automation Engineer/ }).click();
  await page.getByLabel('First name').fill('Asha');
  await page.getByLabel('Last name').fill('Verma');
  await page.locator('#em').fill('asha.verma@example.com');
  await page.getByLabel('Phone').fill('+91 99887 76655');
  await page.getByLabel(/Expected CTC/).fill('1500000');
  await page.locator('input[type=file]').setInputFiles({ name: 'Asha-Verma-CV.pdf', mimeType: 'application/pdf', buffer: samplePdf() });
  await page.getByLabel(/I consent/).check();
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect(page.getByRole('heading', { name: 'Application submitted!' })).toBeVisible();

  // 6. Candidate appears in HRMS
  await page.goto('/app/recruitment/candidates');
  await page.getByRole('cell', { name: /Asha Verma/ }).click();
  await expect(page.getByRole('heading', { name: 'Asha Verma' })).toBeVisible();
  await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible();

  // 7. Shortlist
  await page.getByRole('button', { name: 'Change stage' }).click();
  await page.getByRole('dialog').getByLabel('New stage').selectOption('shortlisted');
  await page.getByRole('button', { name: 'Update stage' }).click();
  await expect(page.getByText(/Moved to Shortlisted/)).toBeVisible();

  // 8. Schedule interview (starts in 10 minutes so feedback can be submitted)
  await page.getByRole('button', { name: 'Interview' }).click();
  await page.getByRole('dialog').getByLabel('Date & time').fill(localDateTime(10));
  await page.getByRole('dialog').getByLabel('Meeting link').fill('https://meet.example.com/qa');
  await page.getByRole('checkbox', { name: /Quinn QA/ }).check();
  await page.getByRole('button', { name: 'Schedule & notify' }).click();
  await expect(page.getByText(/Interview scheduled/)).toBeVisible();
  await expect(page.getByText('Interview', { exact: true }).first()).toBeVisible();

  // 9. Interviewer feedback
  await page.getByRole('tab', { name: /Interviews/ }).click();
  await page.getByRole('button', { name: 'Add feedback' }).click();
  await page.getByRole('radiogroup', { name: 'Overall *' }).getByRole('radio', { name: '5 stars' }).click();
  await page.getByRole('radiogroup', { name: 'Technical' }).getByRole('radio', { name: '4 stars' }).click();
  await page.getByRole('button', { name: 'Strong Hire' }).click();
  await page.getByRole('dialog').getByLabel('Strengths').fill('Excellent automation design skills');
  await page.getByRole('button', { name: 'Submit feedback' }).click();
  await expect(page.getByText('Feedback submitted')).toBeVisible();

  // 10. Select
  await page.getByRole('button', { name: 'Change stage' }).click();
  await page.getByRole('dialog').getByLabel('New stage').selectOption('selected');
  await page.getByRole('button', { name: 'Update stage' }).click();
  await expect(page.getByText(/Moved to Selected/)).toBeVisible();

  // 11. Generate offer → approval
  await page.getByRole('button', { name: 'Create offer' }).click();
  await expect(page.getByRole('dialog').getByLabel(/Annual CTC/)).toHaveValue('1500000');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/app\/offers\//);
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Pending Approval').first()).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();

  // 12. Send offer (PDF generated, uploaded, email queued) and capture the secure link
  await page.getByRole('button', { name: 'Send offer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Offer sent' });
  await expect(dialog).toBeVisible();
  const link = (await dialog.locator('code').innerText()).trim();
  expect(link).toMatch(/\/offer\/[0-9a-f]{64}$/);
  await dialog.getByRole('button', { name: 'Done' }).click();

  // email integration (mock): offer email with PDF attachment logged and delivered
  await nav(page, '/app/emails');
  await expect(page.getByText('Mock delivery mode')).toBeVisible();
  await expect(page.getByText('Your offer from Acme QA — QA Automation Engineer')).toBeVisible();
  await page.getByText('Your offer from Acme QA — QA Automation Engineer').click();
  await expect(page.getByText('Offer-Letter-OFR-', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');

  // 13. Candidate accepts via secure link
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Congratulations, Asha Verma!' })).toBeVisible();
  await page.getByLabel('Full name (e-signature)').fill('Asha Verma');
  await page.getByLabel(/I have read the offer letter/).check();
  await page.getByRole('button', { name: 'Accept offer' }).click();
  await expect(page.getByText(/You accepted this offer/)).toBeVisible();

  // 14. Onboarding: confirm joining, complete
  await page.goto('/app/onboarding');
  await page.getByRole('cell', { name: /Asha Verma/ }).click();
  await expect(page.getByText('Onboarding checklist')).toBeVisible();
  await page.getByRole('checkbox', { name: /Mark Collect signed offer/ }).check();
  await page.getByRole('button', { name: 'Confirm joining' }).click();
  await page.getByRole('button', { name: 'Confirm & notify' }).click();
  await expect(page.getByText(/Joining confirmed/)).toBeVisible();
  await page.getByRole('button', { name: 'Complete & create employee' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create employee' }).click();

  // 15-16. Employee record created and listed
  await expect(page).toHaveURL(/\/app\/employees\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: /Asha Verma/ })).toBeVisible();
  await nav(page, '/app/employees');
  await expect(page.getByRole('cell', { name: /Asha Verma/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'EMP-0001' })).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
