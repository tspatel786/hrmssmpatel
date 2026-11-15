import { ArrowRight, BarChart3, Briefcase, Building2, CalendarDays, CheckCircle2, FileSignature, KanbanSquare, Lock, Mail, ShieldCheck, Users, Wallet } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { useSession } from '@/contexts/session';
import { config, DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/lib/config';

const FEATURES = [
  { icon: Briefcase, title: 'Careers site & job openings', text: 'Branded careers page per company, requisition approvals and one-click publishing.' },
  { icon: KanbanSquare, title: 'Recruitment pipeline', text: 'Drag-and-drop Kanban, resume management, notes, ratings and full stage history.' },
  { icon: CalendarDays, title: 'Interview scheduling', text: 'Conflict-aware scheduling, interactive calendar, panel notifications and structured feedback.' },
  { icon: FileSignature, title: 'Offers & e-acceptance', text: 'Approval workflow, branded PDF offer letters and secure token-based acceptance — no candidate account needed.' },
  { icon: Users, title: 'Onboarding to employee', text: 'Joining confirmation, onboarding checklists and automatic employee record creation.' },
  { icon: Wallet, title: 'Attendance, leave & payroll', text: 'Clock-in/out, leave balances and approvals, LOP-aware payroll runs and PDF payslips.' },
  { icon: Mail, title: 'Email automation', text: 'Editable templates, deduplicated automatic emails and complete delivery logs.' },
  { icon: BarChart3, title: 'Analytics & reports', text: 'Live dashboards, funnel and workforce reports with CSV export.' },
  { icon: ShieldCheck, title: 'Enterprise-grade security', text: 'Multi-tenant isolation with Postgres Row Level Security, roles & permissions and audit logs.' },
];

export function Landing() {
  const { user } = useSession();
  if (user) return <Navigate to="/app" replace />;
  return (
    <div className="min-h-screen bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white"><Building2 className="h-5 w-5" /></span>
          <span className="text-lg font-semibold">TalentFlow HRMS</span>
        </div>
        <nav className="flex items-center gap-2">
          <Link to="/careers/nimbus" className="btn-ghost hidden sm:inline-flex">Sample careers page</Link>
          <Link to="/login" className="btn-secondary">Sign in</Link>
          <Link to="/signup" className="btn-primary">Get started</Link>
        </nav>
      </header>

      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(37,73,235,0.12),transparent)]" />
        <div className="mx-auto max-w-4xl px-6 pb-16 pt-14 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700">
            <Lock className="h-3.5 w-3.5" /> Multi-tenant SaaS · Row Level Security
          </span>
          <h1 className="mt-6 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
            Hire, onboard and pay your people — <span className="text-brand-600">in one place</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
            From the first application on your careers page to the first payslip: requisitions, interviews, offers, onboarding,
            attendance, leave and payroll with automation at every step.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/signup" className="btn-primary px-5 py-2.5 text-base">Create your company <ArrowRight className="h-4 w-4" /></Link>
            <Link to="/login" className="btn-secondary px-5 py-2.5 text-base">Sign in</Link>
          </div>
        </div>
      </section>

      {config.mode === 'demo' && (
        <section className="mx-auto max-w-5xl px-6 pb-12">
          <div className="card border-amber-200 bg-amber-50/60 p-6">
            <h2 className="font-semibold text-amber-900">You are running the local demo</h2>
            <p className="mt-1 text-sm text-amber-800">
              No Supabase credentials are configured, so the app runs a real PostgreSQL database inside your browser with the same schema,
              security policies and business logic. Emails are delivered in mock mode and visible in the Email Center. Sign in with any account below
              (password <code className="rounded bg-amber-100 px-1.5 py-0.5 font-mono">{DEMO_PASSWORD}</code>):
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {DEMO_ACCOUNTS.map((a) => (
                <Link key={a.email} to={`/login?email=${encodeURIComponent(a.email)}`} className="rounded-lg border border-amber-200 bg-white px-3 py-2.5 text-sm hover:border-amber-300 hover:shadow-sm">
                  <span className="block font-medium text-slate-900">{a.role}</span>
                  <span className="block text-xs text-slate-500">{a.email}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="border-t border-slate-100 bg-slate-50/60 py-16">
        <div className="mx-auto grid max-w-6xl gap-5 px-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="card p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><f.icon className="h-5 w-5" /></span>
              <h3 className="mt-4 font-semibold text-slate-900">{f.title}</h3>
              <p className="mt-1.5 text-sm text-slate-600">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-6 py-16 text-center">
        <h2 className="text-2xl font-semibold">The complete hiring lifecycle, automated</h2>
        <div className="mt-8 flex flex-wrap justify-center gap-2 text-sm">
          {['Application', 'Screening', 'Shortlist', 'Interview', 'Feedback', 'Selection', 'Offer approval', 'Offer email + PDF', 'E-acceptance', 'Onboarding', 'Employee'].map((s, i, a) => (
            <span key={s} className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 font-medium text-slate-700 ring-1 ring-slate-200">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" /> {s}
              </span>
              {i < a.length - 1 && <ArrowRight className="h-4 w-4 text-slate-300" />}
            </span>
          ))}
        </div>
      </section>
      <footer className="border-t border-slate-100 py-8 text-center text-sm text-slate-500">© {new Date().getFullYear()} TalentFlow HRMS</footer>
    </div>
  );
}
