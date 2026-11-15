import { Briefcase, CalendarCheck, CalendarDays, ClipboardEdit, Clock, FileSignature, LogIn, LogOut, Plane, UserPlus, Users, Wallet } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, PageLoader, StatCard } from '@/components/ui';
import { StatusBadge } from '@/components/DataTable';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { stageInfo } from '@/lib/constants';
import { fmtDate, fmtDateTime, fmtMoney, fmtTime, titleCase } from '@/lib/format';
import { useAction, useRpc } from '@/lib/hooks';

/** Company metrics. Since migration 1500 each group is null unless the role holds its permission (see `sections`). */
interface Stats {
  sections?: { people: boolean; recruitment: boolean; offers: boolean; onboarding: boolean; attendance: boolean; leave: boolean; payroll: boolean };
  headcount: number | null; new_hires_month: number | null; exits_month: number | null; open_jobs: number | null; open_positions: number | null;
  applications_30d: number | null; applications_prev_30d: number | null; active_candidates: number | null; interviews_upcoming: number | null;
  offers_pending: number | null; offers_accepted_90d: number | null; offers_declined_90d: number | null; onboarding_active: number | null;
  pending_leave: number | null; present_today: number | null; on_leave_today: number | null; avg_time_to_hire_days: number | null;
  last_payroll: { period: string; net: number; status: string } | null;
  pipeline: { stage: string; count: number }[] | null; applications_trend: { week: string; count: number }[] | null;
  headcount_by_department: { department: string; count: number }[] | null; sources: { source: string; count: number }[] | null;
  attendance_trend: { date: string; present: number; leave: number; absent: number }[] | null;
}
/** Line-manager view of direct reports (migration 1500). */
interface TeamDash {
  team_size: number; present_today: number; on_leave_today: number; not_marked_today: number; late_today: number;
  pending_leave: number; pending_corrections: number;
  members: { id: string; name: string; code: string; status: string | null; check_in: string | null; is_late: boolean }[];
}
interface MyDash {
  employee: { id: string; name: string; code: string; designation: string | null; department: string | null } | null;
  today: { check_in: string | null; check_out: string | null; status: string } | null;
  leave_balances: { type: string; color: string; allocated: number; used: number }[];
  pending_leave: number; month_present: number; team_pending_leave: number;
  holidays: { name: string; date: string }[];
  my_interviews: { id: string; at: string; round: string; candidate: string; job: string; feedback_submitted: boolean }[];
}

const PALETTE = ['#2549eb', '#0891b2', '#7c3aed', '#059669', '#ea580c', '#e11d48', '#d97706', '#4f46e5'];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function SelfService({ companyId }: { companyId: string }) {
  const me = useRpc<MyDash>('my_dashboard', { p_company: companyId });
  const clockIn = useAction(() => api.db.rpc('clock_in', { p_company: companyId }), { success: 'Clocked in. Have a great day!' });
  const clockOut = useAction(() => api.db.rpc('clock_out', { p_company: companyId }), { success: 'Clocked out. See you tomorrow!' });
  if (me.isLoading) return <PageLoader />;
  if (me.isError) return <ErrorState error={me.error} onRetry={() => me.refetch()} />;
  const d = me.data!;
  const pendingFeedback = d.my_interviews.filter((i) => !i.feedback_submitted && new Date(i.at) < new Date());
  const upcoming = d.my_interviews.filter((i) => new Date(i.at) >= new Date());
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      {d.employee ? (
        <Card title="Today" className="lg:col-span-1">
          <p className="text-sm text-slate-500">{fmtDate(new Date(), 'EEEE, dd MMMM')}</p>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Check-in</p><p className="mt-0.5 font-semibold">{d.today?.check_in ? fmtTime(d.today.check_in) : '—'}</p></div>
            <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Check-out</p><p className="mt-0.5 font-semibold">{d.today?.check_out ? fmtTime(d.today.check_out) : '—'}</p></div>
          </div>
          <div className="mt-4">
            {!d.today?.check_in ? (
              <Button className="w-full" icon={<LogIn className="h-4 w-4" />} loading={clockIn.isPending} onClick={() => clockIn.mutate()}>Clock in</Button>
            ) : !d.today?.check_out ? (
              <Button variant="secondary" className="w-full" icon={<LogOut className="h-4 w-4" />} loading={clockOut.isPending} onClick={() => clockOut.mutate()}>Clock out</Button>
            ) : (
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-center text-sm font-medium text-emerald-700">Day complete · {titleCase(d.today.status)}</p>
            )}
          </div>
          <p className="mt-3 text-xs text-slate-500">{d.month_present} day(s) present this month</p>
        </Card>
      ) : (
        <Card title="Self-service" className="lg:col-span-1">
          <p className="text-sm text-slate-500">Your user account is not linked to an employee profile, so attendance and leave self-service are unavailable.</p>
        </Card>
      )}
      <Card title="Leave balance" actions={<Link to="/app/leave" className="text-sm font-medium text-brand-700 hover:underline">Apply leave</Link>}>
        {d.leave_balances.length === 0 ? <p className="text-sm text-slate-500">No leave balances allocated for this year.</p> : (
          <ul className="space-y-3">
            {d.leave_balances.map((b) => (
              <li key={b.type}>
                <div className="flex justify-between text-sm"><span className="font-medium">{b.type}</span><span className="text-slate-500">{b.allocated - b.used} / {b.allocated} left</span></div>
                <div className="mt-1.5 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full" style={{ width: `${b.allocated ? Math.min(100, ((b.allocated - b.used) / b.allocated) * 100) : 0}%`, background: b.color }} /></div>
              </li>
            ))}
          </ul>
        )}
        {(d.pending_leave > 0 || d.team_pending_leave > 0) && (
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            {d.pending_leave > 0 && <Badge tone="yellow">{d.pending_leave} request(s) awaiting approval</Badge>}
            {d.team_pending_leave > 0 && <Link to="/app/leave?tab=approvals"><Badge tone="blue">{d.team_pending_leave} team request(s) to review</Badge></Link>}
          </div>
        )}
      </Card>
      <Card title="Upcoming holidays">
        {d.holidays.length === 0 ? <p className="text-sm text-slate-500">No upcoming holidays.</p> : (
          <ul className="divide-y divide-slate-100">
            {d.holidays.map((h) => (
              <li key={h.date} className="flex items-center justify-between py-2 text-sm"><span className="font-medium">{h.name}</span><span className="text-slate-500">{fmtDate(h.date, 'EEE, dd MMM')}</span></li>
            ))}
          </ul>
        )}
      </Card>
      {d.my_interviews.length > 0 && (
        <Card title="My interviews" className="lg:col-span-3" actions={<Link to="/app/recruitment/interviews" className="text-sm font-medium text-brand-700 hover:underline">Open calendar</Link>}>
          {pendingFeedback.length > 0 && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{pendingFeedback.length} interview(s) need your feedback.</p>}
          <ul className="divide-y divide-slate-100">
            {[...pendingFeedback, ...upcoming].slice(0, 6).map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span><span className="font-medium">{i.candidate}</span> <span className="text-slate-500">· {i.job} · {i.round}</span></span>
                <span className="flex items-center gap-2 text-slate-500">{fmtDateTime(i.at)} {!i.feedback_submitted && new Date(i.at) < new Date() && <Badge tone="yellow">Feedback due</Badge>}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Shown only to people with direct reports; hidden on databases without migration 1500 (the RPC is missing there). */
function TeamCard({ companyId }: { companyId: string }) {
  const team = useRpc<TeamDash>('team_dashboard', { p_company: companyId });
  const t = team.data;
  if (team.isLoading || team.isError || !t || t.team_size === 0) return null;
  return (
    <Card title={`My team (${t.team_size})`} actions={<Link to="/app/attendance?tab=team" className="text-sm font-medium text-brand-700 hover:underline">Team attendance</Link>}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="In today" value={t.present_today} tone="green" icon={<CalendarCheck className="h-5 w-5" />} hint={`${t.late_today} late`} />
        <StatCard label="On leave today" value={t.on_leave_today} tone="violet" icon={<Plane className="h-5 w-5" />} hint={`${t.not_marked_today} not marked yet`} />
        <Link to="/app/leave?tab=approvals" className="block"><StatCard label="Leave to approve" value={t.pending_leave} tone="amber" icon={<Plane className="h-5 w-5" />} hint="Open approvals" /></Link>
        <Link to="/app/attendance?tab=corrections" className="block"><StatCard label="Corrections to review" value={t.pending_corrections} tone="rose" icon={<ClipboardEdit className="h-5 w-5" />} hint="Open corrections" /></Link>
      </div>
      <ul className="mt-4 divide-y divide-slate-100" data-testid="team-members">
        {t.members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span><span className="font-medium text-slate-800">{m.name}</span> <span className="text-xs text-slate-500">{m.code}</span></span>
            <span className="flex items-center gap-2">
              {m.check_in && <span className="text-xs text-slate-500">in {fmtTime(m.check_in)}</span>}
              {m.is_late && <Badge tone="yellow">Late</Badge>}
              {m.status ? <StatusBadge kind="attendance" value={m.status} /> : <span className="text-xs text-slate-400">Not marked</span>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function Dashboard() {
  const { companyId, company, can } = useCompany();
  const { user } = useSession();
  const canDash = can('dashboard.view');
  const stats = useRpc<Stats>('dashboard_stats', canDash && companyId ? { p_company: companyId } : null);
  const name = user?.fullName?.split(' ')[0] ?? '';
  const s = stats.data;
  // which sections this role may see: the database decides (migration 1500); older databases fall back to permissions
  const sec = (key: keyof NonNullable<Stats['sections']>, ...perms: string[]) => (s?.sections ? s.sections[key] : perms.some((p) => can(p)));
  const show = {
    people: sec('people', 'employees.view'), recruitment: sec('recruitment', 'candidates.view'), offers: sec('offers', 'offers.view'),
    onboarding: sec('onboarding', 'onboarding.view'), attendance: sec('attendance', 'attendance.view'), leave: sec('leave', 'leave.view', 'leave.approve'),
    payroll: sec('payroll', 'payroll.view'),
  };
  const trend = s && s.applications_prev_30d && s.applications_30d !== null ? Math.round(((s.applications_30d - s.applications_prev_30d) / s.applications_prev_30d) * 100) : undefined;
  const responded = s ? (s.offers_accepted_90d ?? 0) + (s.offers_declined_90d ?? 0) : 0;
  const offerRate = s && responded > 0 ? Math.round(((s.offers_accepted_90d ?? 0) / responded) * 100) : null;

  return (
    <div className="space-y-6">
      <PageHeader title={`${greeting()}${name ? `, ${name}` : ''}`} description={`Here's what's happening at ${company?.name ?? 'your company'} today.`}
        actions={can('jobs.manage') ? <Link to="/app/recruitment/jobs?new=1" className="btn-primary"><Briefcase className="h-4 w-4" /> Post a job</Link> : undefined} />

      {companyId && <SelfService companyId={companyId} />}
      {companyId && <TeamCard companyId={companyId} />}

      {canDash && (stats.isLoading ? <PageLoader /> : stats.isError ? <ErrorState error={stats.error} onRetry={() => stats.refetch()} /> : s && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="company-stats">
            {show.people && <StatCard label="Headcount" value={s.headcount ?? 0} icon={<Users className="h-5 w-5" />} hint={`${s.new_hires_month ?? 0} joined this month`} />}
            {show.recruitment && <StatCard label="Open jobs" value={s.open_jobs ?? 0} icon={<Briefcase className="h-5 w-5" />} tone="violet" hint={`${s.open_positions ?? 0} open positions`} />}
            {show.recruitment && <StatCard label="Applications (30 days)" value={s.applications_30d ?? 0} icon={<UserPlus className="h-5 w-5" />} tone="cyan" trend={trend !== undefined ? { value: trend } : undefined} hint="vs previous 30 days" />}
            {show.recruitment && <StatCard label="Interviews (next 7 days)" value={s.interviews_upcoming ?? 0} icon={<CalendarDays className="h-5 w-5" />} tone="amber" hint={`${s.active_candidates ?? 0} active candidates`} />}
            {show.offers && <StatCard label="Offers in progress" value={s.offers_pending ?? 0} icon={<FileSignature className="h-5 w-5" />} tone="rose" hint={offerRate !== null ? `${offerRate}% acceptance (90 days)` : 'No responses yet'} />}
            {show.attendance && <StatCard label="Present today" value={s.present_today ?? 0} icon={<CalendarCheck className="h-5 w-5" />} tone="green" hint={`${s.on_leave_today ?? 0} on leave`} />}
            {show.leave && <StatCard label="Pending leave requests" value={s.pending_leave ?? 0} icon={<Plane className="h-5 w-5" />} tone="amber" hint={show.onboarding ? `${s.onboarding_active ?? 0} onboarding in progress` : undefined} />}
            {show.payroll && <StatCard label="Last payroll" value={s.last_payroll ? fmtMoney(s.last_payroll.net, company?.currency, true) : '—'} icon={<Wallet className="h-5 w-5" />} tone="blue"
              hint={s.last_payroll ? `${s.last_payroll.period} · ${titleCase(s.last_payroll.status)}` : 'No payroll run yet'} />}
          </div>

          {show.recruitment && s.applications_trend && s.pipeline && (
            <div className="grid gap-5 lg:grid-cols-3">
              <Card title="Applications trend" className="lg:col-span-2" actions={<span className="text-xs text-slate-500">Last 8 weeks</span>}>
                <div className="h-64">
                  <ResponsiveContainer>
                    <AreaChart data={s.applications_trend} margin={{ left: -20, right: 8, top: 8 }}>
                      <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2549eb" stopOpacity={0.25} /><stop offset="100%" stopColor="#2549eb" stopOpacity={0} /></linearGradient></defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                      <XAxis dataKey="week" tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} />
                      <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }} />
                      <Area type="monotone" dataKey="count" name="Applications" stroke="#2549eb" strokeWidth={2} fill="url(#g1)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </Card>
              <Card title="Hiring pipeline" actions={<Link to="/app/recruitment/pipeline" className="text-sm font-medium text-brand-700 hover:underline">Open</Link>}>
                {s.pipeline.every((p) => p.count === 0) ? <EmptyState title="No applications yet" /> : (
                  <ul className="space-y-2.5">
                    {s.pipeline.map((p) => {
                      const max = Math.max(...(s.pipeline ?? []).map((x) => x.count), 1);
                      const info = stageInfo(p.stage);
                      return (
                        <li key={p.stage}>
                          <div className="flex justify-between text-sm"><span>{info.label}</span><span className="font-semibold">{p.count}</span></div>
                          <div className="mt-1 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full" style={{ width: `${(p.count / max) * 100}%`, background: info.color }} /></div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {s.avg_time_to_hire_days !== null && <p className="mt-4 flex items-center gap-1.5 text-xs text-slate-500"><Clock className="h-3.5 w-3.5" /> Avg. time to hire: {s.avg_time_to_hire_days} days</p>}
              </Card>
            </div>
          )}

          {((show.attendance && s.attendance_trend) || (show.people && s.headcount_by_department)) && (
            <div className="grid gap-5 lg:grid-cols-3">
              {show.attendance && s.attendance_trend && (
                <Card title="Attendance (last 14 days)" className="lg:col-span-2">
                  <div className="h-64">
                    <ResponsiveContainer>
                      <BarChart data={s.attendance_trend} margin={{ left: -20, right: 8, top: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                        <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} />
                        <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }} />
                        <Bar dataKey="present" stackId="a" fill="#059669" name="Present" />
                        <Bar dataKey="leave" stackId="a" fill="#7c3aed" name="On leave" />
                        <Bar dataKey="absent" stackId="a" fill="#e11d48" name="Absent" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
              )}
              {show.people && s.headcount_by_department && (
                <Card title="Headcount by department">
                  {s.headcount_by_department.length === 0 ? <EmptyState title="No employees yet" /> : (
                    <>
                      <div className="h-44">
                        <ResponsiveContainer>
                          <PieChart>
                            <Pie data={s.headcount_by_department} dataKey="count" nameKey="department" innerRadius={45} outerRadius={70} paddingAngle={2}>
                              {s.headcount_by_department.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                            </Pie>
                            <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <ul className="mt-2 space-y-1.5 text-sm">
                        {s.headcount_by_department.map((d, i) => (
                          <li key={d.department} className="flex items-center justify-between">
                            <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />{d.department}</span>
                            <span className="font-medium">{d.count}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </Card>
              )}
            </div>
          )}

          {show.recruitment && s.sources && s.sources.length > 0 && (
            <Card title="Candidate sources">
              <div className="flex flex-wrap gap-3">
                {[...s.sources].sort((a, b) => b.count - a.count).map((x, i) => (
                  <div key={x.source} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
                    {titleCase(x.source)} <span className="font-semibold">{x.count}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      ))}
    </div>
  );
}
