// Seeds the in-browser demo database by driving the REAL business RPCs as real
// users (RLS enforced), so the demo exercises the same rules as production.
// Only timestamps are back-dated with superuser SQL to produce realistic history.
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_PASSWORD } from '../../config';
import { generateOfferPdf, generateSampleResume } from '../../pdf';
import { createAuthUser } from './index';
import { LocalDb, runAs } from './localDb';

const day = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * day);

// deterministic pseudo-random so the demo looks the same on every reset
let seedState = 42;
const rand = () => ((seedState = (seedState * 1103515245 + 12345) % 2147483648) / 2147483648);

export async function seedDemoData(pg: PGlite): Promise<void> {
  seedState = 42;
  const users: Record<string, string> = {};
  const mk = async (key: string, email: string, name: string) => {
    users[key] = (await createAuthUser(pg, email, DEMO_PASSWORD, name)).id;
  };
  await mk('admin', 'admin@platform.test', 'Platform Admin');
  await mk('hr', 'hr@nimbus.test', 'Neha Kapoor');
  await mk('recruiter', 'recruiter@nimbus.test', 'Rahul Mehta');
  await mk('manager', 'manager@nimbus.test', 'Arjun Rao');
  await mk('payroll', 'payroll@nimbus.test', 'Kavya Iyer');
  await mk('employee', 'employee@nimbus.test', 'Sneha Patil');
  await mk('other', 'owner@orbit.test', 'Omar Khan');
  await pg.query('insert into public.platform_admins (user_id) values ($1)', [users.admin]);

  const as = (k: string) => new LocalDb(pg, () => ({ role: 'authenticated', sub: users[k] }));
  const anon = new LocalDb(pg, () => ({ role: 'anon' }));
  const hr = as('hr');

  // ---------- company ----------
  const company = await hr.rpc<string>('create_company', { p_name: 'Nimbus Technologies', p_slug: 'nimbus', p_email: 'careers@nimbus.test' });
  await hr.update('companies', company, {
    legal_name: 'Nimbus Technologies Pvt. Ltd.', website: 'https://nimbus.example.com', phone: '+91 80 4000 1234',
    address: '4th Floor, Prestige Tech Park, Outer Ring Road', city: 'Bengaluru', state: 'Karnataka', postal_code: '560103',
    careers_tagline: 'Build the future of cloud collaboration with us',
    careers_about: 'Nimbus Technologies builds collaboration software used by 2,000+ teams worldwide. We are a remote-friendly, engineering-led company that values ownership, curiosity and kindness.',
    email_from_name: 'Nimbus Talent Team', tds_percent: 5,
  });
  // a second tenant to demonstrate isolation in the super admin console
  const orbit = await as('other').rpc<string>('create_company', { p_name: 'Orbit Retail', p_slug: 'orbit-retail' });

  const ids = async (table: string, col: string) =>
    Object.fromEntries((await hr.list<Record<string, string>>({ table, filters: [{ column: 'company_id', op: 'eq', value: company }] }))
      .rows.map((r) => [r[col], r.id]));
  const role = await ids('roles', 'name');
  const dept = await ids('departments', 'name');
  const desig = await ids('designations', 'title');
  for (const t of ['Product Designer', 'Data Analyst', 'HR Manager', 'Sales Manager']) {
    const r = await hr.insert<{ id: string }>('designations', { company_id: company, title: t, level: t.includes('Manager') ? 'M1' : 'L2' });
    desig[t] = r.id;
  }
  await hr.insert('departments', { company_id: company, name: 'Design', code: 'DES' }).then((r) => (dept.Design = (r as { id: string }).id));

  // ---------- employees ----------
  const today = new Date();
  const people: [string, string, string, string, string, number, string | null][] = [
    // first, last, email, dept, designation, monthly gross, user key
    ['Neha', 'Kapoor', 'hr@nimbus.test', 'Human Resources', 'HR Manager', 180000, 'hr'],
    ['Arjun', 'Rao', 'manager@nimbus.test', 'Engineering', 'Engineering Manager', 260000, 'manager'],
    ['Rahul', 'Mehta', 'recruiter@nimbus.test', 'Human Resources', 'HR Executive', 85000, 'recruiter'],
    ['Kavya', 'Iyer', 'payroll@nimbus.test', 'Finance', 'Accountant', 95000, 'payroll'],
    ['Sneha', 'Patil', 'employee@nimbus.test', 'Engineering', 'Software Engineer', 110000, 'employee'],
    ['Vikram', 'Singh', 'vikram.singh@nimbus.test', 'Engineering', 'Senior Software Engineer', 175000, null],
    ['Ananya', 'Das', 'ananya.das@nimbus.test', 'Engineering', 'Software Engineer', 105000, null],
    ['Rohan', 'Joshi', 'rohan.joshi@nimbus.test', 'Engineering', 'Software Engineer', 98000, null],
    ['Meera', 'Nair', 'meera.nair@nimbus.test', 'Design', 'Product Designer', 120000, null],
    ['Karan', 'Malhotra', 'karan.malhotra@nimbus.test', 'Sales', 'Sales Manager', 150000, null],
    ['Pooja', 'Reddy', 'pooja.reddy@nimbus.test', 'Sales', 'Sales Executive', 70000, null],
    ['Aditya', 'Kulkarni', 'aditya.kulkarni@nimbus.test', 'Operations', 'Data Analyst', 90000, null],
    ['Divya', 'Menon', 'divya.menon@nimbus.test', 'Finance', 'Accountant', 80000, null],
    ['Siddharth', 'Bose', 'siddharth.bose@nimbus.test', 'Sales', 'Sales Executive', 65000, null],
  ];
  const emp: Record<string, string> = {};
  for (let i = 0; i < people.length; i++) {
    const [first, last, email, d, g, gross, userKey] = people[i];
    const joined = addDays(today, -Math.round(120 + rand() * 900));
    const basic = Math.round(gross * 0.5);
    const hra = Math.round(gross * 0.2);
    const r = await hr.insert<{ id: string }>('employees', {
      company_id: company, first_name: first, last_name: last, email, phone: `+91 9${String(800000000 + i * 7919).slice(0, 9)}`,
      department_id: dept[d], designation_id: desig[g], joining_date: iso(joined), status: 'active',
      gender: i % 2 ? 'male' : 'female', city: 'Bengaluru', country: 'India', employment_type: 'full_time', work_location: 'Bengaluru HQ',
      ctc_annual: gross * 12 * 1.05, basic_monthly: basic, hra_monthly: hra, allowances_monthly: gross - basic - hra,
      bank_name: 'HDFC Bank', bank_account_number: `5010${String(10000000 + i * 1237)}`, bank_ifsc: 'HDFC0001234',
      pan_number: `ABCPK${1000 + i}L`, date_of_birth: iso(addDays(today, -Math.round(9000 + rand() * 5000))),
    });
    emp[email] = r.id;
    if (userKey === 'hr') {
      await pg.query('update public.company_members set employee_id = $1 where company_id = $2 and user_id = $3', [r.id, company, users.hr]);
      await pg.query('update public.employees set user_id = $1 where id = $2', [users.hr, r.id]);
    }
  }
  // reporting lines
  const arjun = emp['manager@nimbus.test'];
  for (const e of ['employee@nimbus.test', 'vikram.singh@nimbus.test', 'ananya.das@nimbus.test', 'rohan.joshi@nimbus.test']) {
    await hr.update('employees', emp[e], { manager_id: arjun });
  }
  for (const e of ['pooja.reddy@nimbus.test', 'siddharth.bose@nimbus.test']) await hr.update('employees', emp[e], { manager_id: emp['karan.malhotra@nimbus.test'] });
  await hr.update('departments', dept.Engineering, { head_employee_id: arjun });
  await hr.update('departments', dept['Human Resources'], { head_employee_id: emp['hr@nimbus.test'] });

  // users → roles (linked to their employee records)
  const invite = (email: string, r: string) => hr.rpc('invite_member', { p_company: company, p_email: email, p_role: role[r], p_employee: emp[email] });
  await invite('recruiter@nimbus.test', 'Recruiter');
  await invite('manager@nimbus.test', 'Hiring Manager');
  await invite('payroll@nimbus.test', 'Payroll Manager');
  await invite('employee@nimbus.test', 'Employee');

  // ---------- holidays ----------
  const y = today.getFullYear();
  const holidays: [string, string][] = [
    [`${y}-01-26`, 'Republic Day'], [`${y}-03-14`, 'Holi'], [`${y}-05-01`, 'Labour Day'], [`${y}-08-15`, 'Independence Day'],
    [`${y}-10-02`, 'Gandhi Jayanti'], [`${y}-10-20`, 'Diwali'], [`${y}-12-25`, 'Christmas'],
    [`${y + 1}-01-01`, 'New Year'], [`${y + 1}-01-26`, 'Republic Day'], [`${y + 1}-03-04`, 'Holi'],
  ];
  for (const [d, n] of holidays) await hr.insert('holidays', { company_id: company, name: n, holiday_date: d });

  // ---------- leave ----------
  await hr.rpc('allocate_leave_balances', { p_company: company, p_year: y });
  const lt = await ids('leave_types', 'code');
  const sneha = as('employee');
  const nextWeekday = (offset: number) => {
    let d = addDays(today, offset);
    while (d.getDay() === 0 || d.getDay() === 6 || holidays.some((h) => h[0] === iso(d))) d = addDays(d, 1);
    return iso(d);
  };
  const pendingLeave = nextWeekday(9);
  await sneha.rpc('apply_leave', { p_company: company, p_employee: null, p_type: lt.CL, p_start: pendingLeave, p_end: pendingLeave, p_half_day: false, p_reason: 'Attending a family function' });
  const vikramLeave = await hr.rpc<string>('apply_leave', {
    p_company: company, p_employee: emp['vikram.singh@nimbus.test'], p_type: lt.EL, p_start: nextWeekday(14), p_end: nextWeekday(16), p_half_day: false, p_reason: 'Vacation with family',
  });
  void vikramLeave;
  await hr.rpc('apply_leave', { p_company: company, p_employee: emp['pooja.reddy@nimbus.test'], p_type: lt.SL, p_start: nextWeekday(3), p_end: nextWeekday(3), p_half_day: false, p_reason: 'Medical appointment' });

  // ---------- attendance: last 20 days ----------
  const allEmp = Object.values(emp);
  const rows: unknown[][] = [];
  for (let back = 20; back >= 1; back--) {
    const d = addDays(today, -back);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const ds = iso(d);
    if (holidays.some((h) => h[0] === ds)) continue;
    for (const e of allEmp) {
      const r = rand();
      if (r < 0.04) rows.push([company, e, ds, null, null, 'absent']);
      else if (r < 0.09) rows.push([company, e, ds, null, null, 'on_leave']);
      else {
        const inMin = 9 * 60 + Math.round(rand() * 75) - 30;
        const outMin = inMin + 8 * 60 + Math.round(rand() * 90);
        const at = (m: number) => new Date(`${ds}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+05:30`).toISOString();
        rows.push([company, e, ds, at(inMin), at(outMin), 'present']);
      }
    }
  }
  for (const r of rows) {
    await pg.query(`insert into public.attendance_records (company_id, employee_id, attendance_date, check_in, check_out, status, source)
      values ($1, $2, $3, $4, $5, $6, 'manual') on conflict do nothing`, r);
  }

  // ---------- payroll: last month processed & paid ----------
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const payroll = as('payroll');
  const run = await payroll.rpc<string>('generate_payroll', { p_company: company, p_year: lastMonth.getFullYear(), p_month: lastMonth.getMonth() + 1 });
  await payroll.rpc('finalize_payroll', { p_run: run });
  await payroll.rpc('mark_payroll_paid', { p_run: run });

  // ---------- recruitment ----------
  const recruiter = as('recruiter');
  const manager = as('manager');
  const req1 = await manager.insert<{ id: string }>('job_requisitions', {
    company_id: company, title: 'Senior Frontend Engineer', department_id: dept.Engineering, designation_id: desig['Senior Software Engineer'],
    headcount: 2, location: 'Bengaluru / Remote', min_salary: 2400000, max_salary: 3600000, priority: 'high', status: 'pending_approval',
    justification: 'Two new product squads need senior frontend expertise to ship the redesigned collaboration suite.',
  });
  await hr.update('job_requisitions', req1.id, { status: 'approved', decision_note: 'Approved within FY budget' });
  await manager.insert('job_requisitions', {
    company_id: company, title: 'Platform SRE', department_id: dept.Engineering, headcount: 1, location: 'Bengaluru',
    min_salary: 2000000, max_salary: 3000000, priority: 'medium', status: 'pending_approval',
    justification: 'On-call load has grown with enterprise customers; we need a dedicated reliability engineer.',
  });
  await recruiter.insert('job_requisitions', {
    company_id: company, title: 'Sales Development Representative', department_id: dept.Sales, headcount: 3, location: 'Mumbai',
    priority: 'low', status: 'draft', justification: 'Expand outbound pipeline for the west region in the next quarter.',
  });

  const jobDefs = [
    { key: 'fe', title: 'Senior Frontend Engineer', d: 'Engineering', g: 'Senior Software Engineer', loc: 'Bengaluru', mode: 'hybrid', min: 2400000, max: 3600000, exp: [5, 9], openings: 2, req: req1.id,
      skills: ['React', 'TypeScript', 'GraphQL', 'Testing'], desc: 'Own the architecture of our React application used by thousands of teams. You will lead complex features end-to-end, mentor engineers and raise the bar on quality and performance.' },
    { key: 'be', title: 'Backend Engineer (Go)', d: 'Engineering', g: 'Software Engineer', loc: 'Remote (India)', mode: 'remote', min: 1600000, max: 2600000, exp: [2, 6], openings: 1,
      skills: ['Go', 'PostgreSQL', 'Kubernetes'], desc: 'Design and build reliable APIs and event pipelines that power real-time collaboration for our customers.' },
    { key: 'pd', title: 'Product Designer', d: 'Design', g: 'Product Designer', loc: 'Bengaluru', mode: 'onsite', min: 1400000, max: 2200000, exp: [3, 7], openings: 1,
      skills: ['Figma', 'Design Systems', 'User Research'], desc: 'Shape delightful, accessible experiences across web and mobile, working closely with product and engineering.' },
    { key: 'se', title: 'Enterprise Sales Executive', d: 'Sales', g: 'Sales Executive', loc: 'Mumbai', mode: 'onsite', min: 900000, max: 1500000, exp: [2, 5], openings: 2,
      skills: ['B2B SaaS', 'Negotiation', 'CRM'], desc: 'Drive new enterprise revenue by running consultative sales cycles with mid-market and enterprise customers.' },
  ];
  const job: Record<string, string> = {};
  for (const j of jobDefs) {
    const r = await recruiter.insert<{ id: string }>('jobs', {
      company_id: company, requisition_id: j.req ?? null, title: j.title, department_id: dept[j.d], designation_id: desig[j.g],
      location: j.loc, work_mode: j.mode, salary_min: j.min, salary_max: j.max, show_salary: true, experience_min: j.exp[0], experience_max: j.exp[1],
      openings: j.openings, skills: j.skills, status: 'published', hiring_manager_id: users.manager, description: j.desc,
      responsibilities: '• Deliver high-quality work in a fast-moving team\n• Collaborate across functions\n• Continuously improve how we work',
      requirements: `• ${j.exp[0]}+ years of relevant experience\n• Strong communication skills\n• Experience with ${j.skills.slice(0, 2).join(' and ')}`,
      benefits: '• Health insurance for family\n• Flexible hours & remote-friendly\n• Learning budget & ESOPs',
      closing_date: iso(addDays(today, 45)),
    });
    job[j.key] = r.id;
  }
  await recruiter.insert('jobs', {
    company_id: company, title: 'Data Analyst', department_id: dept.Operations, designation_id: desig['Data Analyst'], location: 'Bengaluru',
    description: 'Turn product and business data into insights that guide decisions across the company.', status: 'draft', skills: ['SQL', 'Python'],
  });

  const candidates: [string, string, string, string, number, string, string[]][] = [
    ['Priya', 'Sharma', 'fe', 'Senior Frontend Developer', 6, 'linkedin', ['React', 'TypeScript', 'Redux']],
    ['Amit', 'Verma', 'fe', 'Frontend Engineer', 5, 'careers', ['React', 'Next.js', 'CSS']],
    ['Lakshmi', 'Narayan', 'fe', 'UI Engineer', 7, 'referral', ['Vue', 'TypeScript', 'Testing']],
    ['Farhan', 'Ali', 'fe', 'Software Engineer', 4, 'careers', ['React', 'Node.js']],
    ['Ishita', 'Ghosh', 'fe', 'Frontend Lead', 9, 'agency', ['React', 'Architecture', 'GraphQL']],
    ['Nikhil', 'Bhat', 'be', 'Backend Developer', 3, 'careers', ['Go', 'PostgreSQL']],
    ['Tanvi', 'Shah', 'be', 'Software Engineer II', 4, 'linkedin', ['Go', 'gRPC', 'Kafka']],
    ['Manoj', 'Pillai', 'be', 'Systems Engineer', 6, 'careers', ['Java', 'Kubernetes']],
    ['Riya', 'Chatterjee', 'pd', 'UX Designer', 4, 'careers', ['Figma', 'Prototyping']],
    ['Kabir', 'Arora', 'pd', 'Product Designer', 5, 'referral', ['Figma', 'Design Systems']],
    ['Zoya', 'Qureshi', 'se', 'Account Executive', 3, 'job_board', ['SaaS Sales', 'HubSpot']],
    ['Harsh', 'Vardhan', 'se', 'Sales Manager', 6, 'careers', ['Enterprise Sales', 'Negotiation']],
    ['Neelam', 'Saxena', 'se', 'Business Development', 2, 'careers', ['Lead Generation', 'CRM']],
    ['Gaurav', 'Tiwari', 'be', 'Golang Developer', 5, 'careers', ['Go', 'Docker', 'AWS']],
  ];
  const app: Record<string, string> = {};
  for (let i = 0; i < candidates.length; i++) {
    const [first, last, jk, title, years, source, skills] = candidates[i];
    const email = `${first}.${last}`.toLowerCase() + '@example.com';
    const path = `${company}/incoming/${crypto.randomUUID()}/${first}-${last}-Resume.pdf`;
    const blob = generateSampleResume(`${first} ${last}`, title, email, skills, years);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await runAs(pg, { role: 'anon' }, (tx) =>
      tx.query(`insert into storage.objects (bucket_id, name, data, metadata) values ('resumes', $1, $2, $3)`, [path, bytes, JSON.stringify({ mimetype: 'application/pdf', size: bytes.length })]));
    const r = await anon.rpc<{ application_id: string }>('public_submit_application', {
      p_slug: 'nimbus', p_job: job[jk],
      p_data: { first_name: first, last_name: last, email, phone: `+91 98${String(10000000 + i * 104729).slice(0, 8)}`, experience_years: String(years),
        current_title: title, current_company: ['Infosys', 'Flipkart', 'Swiggy', 'TCS', 'Freshworks', 'Zoho'][i % 6], current_location: ['Bengaluru', 'Pune', 'Hyderabad', 'Mumbai'][i % 4],
        expected_ctc: String(1200000 + years * 250000), notice_period_days: String([30, 60, 90][i % 3]), skills: skills.join(', '),
        cover_letter: `I am excited about the ${title} opportunity at Nimbus and would love to contribute my ${years} years of experience.` },
      p_resume: { path, name: `${first}-${last}-Resume.pdf`, size: bytes.length, mime: 'application/pdf' },
    });
    app[first] = r.application_id;
    await pg.query(`update public.candidates set source = $1 where email = $2 and company_id = $3`, [source, email, company]);
    // back-date applications across the last 8 weeks for realistic trends
    const appliedAt = addDays(today, -Math.round(3 + (candidates.length - i) * 3.5));
    await pg.query(`update public.applications set applied_at = $1, created_at = $1, stage_changed_at = $1 where id = $2`, [appliedAt.toISOString(), r.application_id]);
    await pg.query(`update public.application_stage_history set created_at = $1 where application_id = $2`, [appliedAt.toISOString(), r.application_id]);
  }

  const stage = (a: string, s: string, reason?: string) =>
    recruiter.rpc('change_application_stage', { p_application: app[a], p_stage: s, p_note: null, p_reason: reason ?? null });
  for (const a of ['Amit', 'Lakshmi', 'Tanvi', 'Kabir', 'Harsh', 'Priya', 'Ishita', 'Riya']) await stage(a, 'screening');
  for (const a of ['Lakshmi', 'Tanvi', 'Kabir', 'Harsh', 'Priya', 'Ishita']) await stage(a, 'shortlisted');
  await stage('Farhan', 'rejected', 'Experience does not match the senior level required');
  await stage('Neelam', 'on_hold');

  // interviews in the coming days (Arjun + Rahul on panel)
  const at = (days: number, hour: number) => {
    const d = addDays(today, days);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const schedule = (a: string, round: string, days: number, hour: number, panel: string[], type = 'video') =>
    recruiter.rpc<string>('schedule_interview', {
      p_application: app[a], p_round: round, p_type: type, p_at: at(days, hour), p_duration: 60,
      p_location: type === 'onsite' ? 'Bengaluru HQ, Meeting Room 3' : '', p_meeting_link: type === 'video' ? 'https://meet.example.com/nimbus-' + a.toLowerCase() : '',
      p_panelists: panel.map((p) => users[p]),
    });
  await schedule('Lakshmi', 'Technical Round 1', 1, 11, ['manager']);
  await schedule('Tanvi', 'System Design', 2, 15, ['manager', 'recruiter']);
  await schedule('Kabir', 'Portfolio Review', 3, 12, ['recruiter'], 'onsite');
  await schedule('Harsh', 'Sales Pitch', 4, 16, ['recruiter'], 'phone');

  // Priya: interviewed (past), selected and offered
  const priyaIv = await schedule('Priya', 'Technical Round 1', 1, 9, ['manager']);
  await pg.query(`update public.interviews set scheduled_at = now() - interval '6 days' where id = $1`, [priyaIv]);
  await manager.rpc('submit_interview_feedback', {
    p_interview: priyaIv, p_overall: 5, p_technical: 5, p_communication: 4, p_culture: 5, p_recommendation: 'strong_hire',
    p_strengths: 'Deep React expertise, clean architecture thinking, great communication.', p_weaknesses: 'Limited GraphQL experience.', p_comments: 'Strong hire for the senior role.',
  });
  await stage('Priya', 'selected');
  const offer = await recruiter.insert<{ id: string; offer_number: string; created_at: string }>('offers', {
    company_id: company, application_id: app.Priya, designation_id: desig['Senior Software Engineer'], department_id: dept.Engineering,
    reporting_manager_id: arjun, work_location: 'Bengaluru HQ', ctc_annual: 3200000, basic_monthly: 133000, hra_monthly: 53000,
    allowances_monthly: 80600, joining_date: iso(addDays(today, 30)), expiry_date: iso(addDays(today, 7)), probation_months: 6,
    additional_terms: 'You will be eligible for the company ESOP plan subject to board approval.',
  });
  await recruiter.rpc('submit_offer_for_approval', { p_offer: offer.id, p_comments: 'Within approved requisition budget' });
  await manager.rpc('decide_offer', { p_offer: offer.id, p_approve: true, p_comments: 'Approved — excellent candidate' });
  const c = (await hr.get<Record<string, string>>('companies', company))!;
  const pdf = generateOfferPdf({
    offer_number: offer.offer_number, candidate_name: 'Priya Sharma', job_title: 'Senior Frontend Engineer', designation: 'Senior Software Engineer',
    department: 'Engineering', reporting_manager: 'Arjun Rao', employment_type: 'full_time', work_location: 'Bengaluru HQ', ctc_annual: 3200000,
    basic_monthly: 133000, hra_monthly: 53000, allowances_monthly: 80600, joining_date: iso(addDays(today, 30)), expiry_date: iso(addDays(today, 7)),
    probation_months: 6, additional_terms: 'You will be eligible for the company ESOP plan subject to board approval.', issued_at: offer.created_at,
    company: c as never,
  });
  const pdfPath = `${company}/offers/${offer.id}.pdf`;
  const pdfBytes = new Uint8Array(await pdf.arrayBuffer());
  await runAs(pg, { role: 'authenticated', sub: users.recruiter }, (tx) =>
    tx.query(`insert into storage.objects (bucket_id, name, data, metadata) values ('documents', $1, $2, $3)`, [pdfPath, pdfBytes, JSON.stringify({ mimetype: 'application/pdf', size: pdfBytes.length })]));
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
  await recruiter.rpc('send_offer', { p_offer: offer.id, p_base_url: origin, p_pdf_path: pdfPath });

  // Ishita: selected, offer being drafted
  const ishitaIv = await schedule('Ishita', 'Leadership Round', 2, 9, ['manager']);
  await pg.query(`update public.interviews set scheduled_at = now() - interval '3 days' where id = $1`, [ishitaIv]);
  await manager.rpc('submit_interview_feedback', {
    p_interview: ishitaIv, p_overall: 4, p_technical: 4, p_communication: 5, p_culture: 4, p_recommendation: 'hire',
    p_strengths: 'Strong leadership and stakeholder management.', p_weaknesses: 'Needs ramp-up on our stack.', p_comments: 'Recommend hire.',
  });
  await stage('Ishita', 'selected');

  // candidate notes
  await recruiter.insert('candidate_notes', { company_id: company, candidate_id: (await hr.get<{ candidate_id: string }>('applications', app.Priya))!.candidate_id, body: 'Very strong culture fit. Expects joining bonus discussion.', created_by: users.recruiter });

  // ---------- realistic history: back-date timestamps (superuser SQL, demo only) ----------
  await pg.exec(`
    update public.jobs set published_at = now() - ((10 + (abs(hashtext(id::text)) % 35)) || ' days')::interval,
      created_at = now() - ((12 + (abs(hashtext(id::text)) % 35)) || ' days')::interval where status = 'published';
    update public.job_requisitions set created_at = now() - interval '60 days', approved_at = case when approved_at is not null then now() - interval '55 days' end;
    with h as (
      select h.id, a.applied_at, row_number() over (partition by h.application_id order by h.created_at) as rn
      from public.application_stage_history h join public.applications a on a.id = h.application_id
    )
    update public.application_stage_history t set created_at = least(now() - interval '2 hours', h.applied_at + ((h.rn - 1) * 2 || ' days')::interval)
    from h where t.id = h.id and h.rn > 1;
    update public.applications a set stage_changed_at = coalesce((select max(created_at) from public.application_stage_history h where h.application_id = a.id), a.applied_at);
    update public.interviews set scheduled_at = date_trunc('day', scheduled_at) + interval '5 hours' where scheduled_at < now();
    update public.interview_feedback f set submitted_at = i.scheduled_at + interval '2 hours' from public.interviews i where i.id = f.interview_id;
    update public.employees set created_at = joining_date::timestamptz;
  `);
  void orbit;
}
