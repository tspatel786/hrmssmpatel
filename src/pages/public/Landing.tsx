import { ArrowRight, BarChart3, Briefcase, CalendarDays, CheckCircle2, FileSignature, KanbanSquare, Lock, Mail, ShieldCheck, Users, Wallet } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { useSession } from '@/contexts/session';
import { Logo } from '@/components/Logo';
import { config, DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/lib/config';
import { useSignupEnabled } from '@/lib/signup';

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
  const signup = useSignupEnabled();
  if (user) return <Navigate to="/app" replace />;
  // internal HRMS (public sign-up off): no marketing page, straight to sign-in
  if (!signup.loading && !signup.enabled) return <Navigate to="/login" replace />;
  return (
    <div className="min-h-screen bg-ink text-ink-muted">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-ink/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link to="/" className="min-w-0"><Logo size={44} nameClassName="hidden text-white sm:inline" /></Link>
          <nav className="flex items-center gap-2">
            <Link to="/careers/nimbus" className="btn hidden text-white/80 hover:text-brand-400 md:inline-flex">Sample careers page</Link>
            <Link to="/login" className="btn border border-white/15 text-white hover:border-brand-500/60 hover:text-brand-300">Sign in</Link>
            <Link to="/signup" className="btn-primary">Get started</Link>
          </nav>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_45%_at_50%_0%,rgba(212,175,55,0.18),transparent)]" />
        <div className="relative mx-auto max-w-4xl px-6 pb-16 pt-16 text-center sm:pt-20">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-500/30 bg-brand-500/10 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-brand-400 sm:text-xs sm:tracking-[0.18em]">
            <Lock className="h-3.5 w-3.5" /> Enterprise HRMS · {config.companyName}
          </span>
          <h1 className="mt-6 text-4xl font-bold leading-tight text-white sm:text-6xl">
            Hire, onboard and pay your people — <span className="text-gold-gradient">in one place</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-ink-muted">
            From the first application on your careers page to the first payslip: requisitions, interviews, offers, onboarding,
            attendance, leave and payroll with automation at every step.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/signup" className="btn-primary px-5 py-2.5 text-base">Create your company <ArrowRight className="h-4 w-4" /></Link>
            <Link to="/login" className="btn border border-white/15 px-5 py-2.5 text-base text-white hover:border-brand-500/60 hover:text-brand-300">Sign in</Link>
          </div>
        </div>
      </section>

      {config.mode === 'demo' && (
        <section className="mx-auto max-w-5xl px-6 pb-12">
          <div className="rounded-2xl border border-brand-500/30 bg-brand-500/[0.06] p-6">
            <h2 className="font-semibold text-brand-300">You are running the local demo</h2>
            <p className="mt-1 text-sm text-ink-muted">
              No Supabase credentials are configured, so the app runs a real PostgreSQL database inside your browser with the same schema,
              security policies and business logic. Emails are delivered in mock mode and visible in the Email Center. Sign in with any account below
              (password <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-white">{DEMO_PASSWORD}</code>):
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {DEMO_ACCOUNTS.map((a) => (
                <Link key={a.email} to={`/login?email=${encodeURIComponent(a.email)}`} className="rounded-lg border border-white/10 bg-ink-800 px-3 py-2.5 text-sm hover:border-brand-500/50">
                  <span className="block font-medium text-white">{a.role}</span>
                  <span className="block text-xs text-ink-muted">{a.email}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="border-t border-white/10 bg-ink-900 py-16">
        <div className="mx-auto grid max-w-6xl gap-5 px-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl border border-white/10 bg-ink-800 p-6 transition hover:border-brand-500/40">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-brand-500/30 bg-brand-500/10 text-brand-400"><f.icon className="h-5 w-5" /></span>
              <h3 className="mt-4 font-semibold text-white">{f.title}</h3>
              <p className="mt-1.5 text-sm text-ink-muted">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-6 py-16 text-center">
        <h2 className="text-2xl font-semibold text-white sm:text-3xl">The complete hiring lifecycle, <span className="text-gold-gradient">automated</span></h2>
        <div className="mt-8 flex flex-wrap justify-center gap-2 text-sm">
          {['Application', 'Screening', 'Shortlist', 'Interview', 'Feedback', 'Selection', 'Offer approval', 'Offer email + PDF', 'E-acceptance', 'Onboarding', 'Employee'].map((s, i, a) => (
            <span key={s} className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-ink-800 px-3 py-1.5 font-medium text-white/90">
                <CheckCircle2 className="h-4 w-4 text-brand-400" /> {s}
              </span>
              {i < a.length - 1 && <ArrowRight className="h-4 w-4 text-white/25" />}
            </span>
          ))}
        </div>
      </section>
      <footer className="border-t border-white/10 py-8 text-center text-sm text-ink-muted">
        © {new Date().getFullYear()} {config.appName} · A product of{' '}
        <a href={config.companyUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-400 hover:text-brand-300">{config.companyName}</a>
      </footer>
    </div>
  );
}
