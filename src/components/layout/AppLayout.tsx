import clsx from 'clsx';
import {
  BarChart3, Bell, Briefcase, Building2, CalendarCheck, CalendarDays, ChevronDown, ClipboardList, FileSignature, FileText,
  KanbanSquare, LayoutDashboard, LogOut, Mail, Menu, Network, Plane, Settings, ShieldCheck, UserCheck, UserCircle, Users,
  UsersRound, Wallet, X, History, Crown, Check, MessagesSquare, Moon, Monitor, Sun,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ChatProvider, useChat } from '@/contexts/chat';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { config } from '@/lib/config';
import { fmtRelative } from '@/lib/format';
import { useAction, useList } from '@/lib/hooks';
import { useTheme, type ThemePref } from '@/lib/theme';
import { Avatar, Badge, PageLoader } from '../ui';

const NEXT_THEME: Record<ThemePref, ThemePref> = { light: 'dark', dark: 'system', system: 'light' };
const THEME_LABEL: Record<ThemePref, string> = { light: 'Light theme', dark: 'Dark theme', system: 'System theme' };
function ThemeToggle() {
  const { pref, setPref } = useTheme();
  const Icon = pref === 'dark' ? Moon : pref === 'system' ? Monitor : Sun;
  return (
    <button type="button" className="btn-ghost p-2" onClick={() => setPref(NEXT_THEME[pref])}
      aria-label={`${THEME_LABEL[pref]} (switch to ${THEME_LABEL[NEXT_THEME[pref]].toLowerCase()})`} title={`${THEME_LABEL[pref]} — click to change`} data-testid="theme-toggle">
      <Icon className="h-5 w-5" />
    </button>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  perm?: string | string[];
  end?: boolean;
  badge?: 'chat';
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

const ic = 'h-[18px] w-[18px] shrink-0';
export const NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { to: '/app', label: 'Dashboard', icon: <LayoutDashboard className={ic} />, end: true },
      { to: '/app/notifications', label: 'Notifications', icon: <Bell className={ic} /> },
      { to: '/app/communication', label: 'Communication', icon: <MessagesSquare className={ic} />, badge: 'chat' },
    ],
  },
  {
    label: 'Recruitment',
    items: [
      { to: '/app/recruitment/requisitions', label: 'Requisitions', icon: <ClipboardList className={ic} />, perm: ['requisitions.view', 'requisitions.manage', 'requisitions.approve'] },
      { to: '/app/recruitment/jobs', label: 'Job Openings', icon: <Briefcase className={ic} />, perm: ['jobs.view', 'jobs.manage'] },
      { to: '/app/recruitment/candidates', label: 'Candidates', icon: <Users className={ic} />, perm: 'candidates.view' },
      { to: '/app/recruitment/pipeline', label: 'Pipeline', icon: <KanbanSquare className={ic} />, perm: 'candidates.view' },
      { to: '/app/recruitment/interviews', label: 'Interviews', icon: <CalendarDays className={ic} /> },
      { to: '/app/offers', label: 'Offers', icon: <FileSignature className={ic} />, perm: ['offers.view', 'offers.approve'] },
      { to: '/app/onboarding', label: 'Onboarding', icon: <UserCheck className={ic} />, perm: 'onboarding.view' },
    ],
  },
  {
    label: 'People',
    items: [
      { to: '/app/employees', label: 'Employees', icon: <UsersRound className={ic} />, perm: 'employees.view' },
      { to: '/app/organization', label: 'Organization', icon: <Network className={ic} />, perm: 'departments.view' },
      { to: '/app/attendance', label: 'Attendance', icon: <CalendarCheck className={ic} /> },
      { to: '/app/leave', label: 'Leave', icon: <Plane className={ic} /> },
      { to: '/app/payroll', label: 'Payroll', icon: <Wallet className={ic} />, perm: 'payroll.view' },
      { to: '/app/payroll/my-payslips', label: 'My Payslips', icon: <FileText className={ic} /> },
    ],
  },
  {
    label: 'Insights & Admin',
    items: [
      { to: '/app/reports', label: 'Reports', icon: <BarChart3 className={ic} />, perm: 'reports.view' },
      { to: '/app/emails', label: 'Email Center', icon: <Mail className={ic} />, perm: 'emails.manage' },
      { to: '/app/audit', label: 'Audit Logs', icon: <History className={ic} />, perm: 'audit.view' },
      { to: '/app/settings', label: 'Settings', icon: <Settings className={ic} />, perm: ['settings.manage', 'users.manage'] },
    ],
  },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can, company, isSuperAdmin } = useCompany();
  const { unreadTotal } = useChat();
  return (
    <div className="flex h-full flex-col bg-slate-900">
      <Link to="/app" className="flex h-16 shrink-0 items-center gap-2.5 px-5" onClick={onNavigate}>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-white shadow-lg shadow-brand-500/30">
          <Building2 className="h-4 w-4" />
        </span>
        <span className="text-[15px] font-semibold text-white">TalentFlow</span>
        {config.mode === 'demo' && <Badge tone="yellow" className="ml-auto !py-0 text-[10px]">DEMO</Badge>}
      </Link>
      <nav className="scrollbar-thin flex-1 space-y-6 overflow-y-auto px-3 pb-6 pt-2" aria-label="Main navigation">
        {NAV.map((g) => {
          const items = g.items.filter((i) => !i.perm || can(i.perm));
          if (!items.length) return null;
          return (
            <div key={g.label}>
              <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{g.label}</p>
              <ul className="space-y-0.5">
                {items.map((i) => (
                  <li key={i.to}>
                    <NavLink to={i.to} end={i.end ?? i.to === '/app/payroll'} onClick={onNavigate}
                      className={({ isActive }) => clsx('nav-link', isActive && 'nav-link-active')}>
                      {i.icon}
                      {i.label}
                      {i.badge === 'chat' && unreadTotal > 0 && (
                        <span className="ml-auto rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white" aria-label={`${unreadTotal} unread messages`}>
                          {unreadTotal > 99 ? '99+' : unreadTotal}
                        </span>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {isSuperAdmin && (
          <div>
            <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Platform</p>
            <NavLink to="/admin" onClick={onNavigate} className={({ isActive }) => clsx('nav-link', isActive && 'nav-link-active')}>
              <Crown className={ic} /> Super Admin
            </NavLink>
          </div>
        )}
      </nav>
      {company && (
        <div className="border-t border-white/10 p-4 text-xs text-slate-400">
          <div className="flex items-center justify-between">
            <span className="capitalize">{company.plan} plan</span>
            <span className="capitalize">{company.status}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function useClickOutside(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  return ref;
}

function CompanySwitcher() {
  const { companies, companyId, switchCompany } = useCompany();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const current = companies.find((c) => c.id === companyId);
  const navigate = useNavigate();
  if (!current) return null;
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        className="flex max-w-[220px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm hover:bg-slate-50">
        <Avatar name={current.name} size="xs" src={current.logo_url} />
        <span className="truncate font-medium text-slate-800">{current.name}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>
      {open && (
        <div role="menu" className="animate-in absolute left-0 z-40 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop">
          <p className="px-2.5 py-1.5 text-xs font-semibold uppercase text-slate-400">Your companies</p>
          {companies.map((c) => (
            <button key={c.id} role="menuitem" type="button" onClick={() => { switchCompany(c.id); setOpen(false); navigate('/app'); }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-slate-50">
              <Avatar name={c.name} size="sm" src={c.logo_url} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-slate-800">{c.name}</span>
                <span className="block truncate text-xs text-slate-500">{c.role_name}</span>
              </span>
              {c.id === companyId && <Check className="h-4 w-4 text-brand-600" />}
            </button>
          ))}
          <Link to="/onboarding/company" className="mt-1 block rounded-lg border-t border-slate-100 px-2.5 py-2 text-sm font-medium text-brand-700 hover:bg-slate-50" onClick={() => setOpen(false)}>
            + Create a new company
          </Link>
        </div>
      )}
    </div>
  );
}

interface Notification {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

function NotificationBell() {
  const { user } = useSession();
  const { companyId } = useCompany();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const navigate = useNavigate();
  const list = useList<Notification>(user ? {
    table: 'notifications', filters: [{ column: 'user_id', op: 'eq', value: user.id }, { column: 'company_id', op: 'eq', value: companyId }],
    order: [{ column: 'created_at', ascending: false }], range: [0, 7],
  } : null, { refetchInterval: 30000 });
  const unread = useList<Notification>(user ? {
    table: 'notifications', columns: 'id', filters: [{ column: 'user_id', op: 'eq', value: user.id }, { column: 'company_id', op: 'eq', value: companyId }, { column: 'read_at', op: 'is', value: null }],
    range: [0, 0],
  } : null, { refetchInterval: 30000 });
  const markAll = useAction(() => api.db.rpc('mark_notifications_read', { p_ids: null }), { silent: true });
  const count = unread.data?.count ?? 0;
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn-ghost relative p-2" onClick={() => setOpen((o) => !o)} aria-label={`Notifications${count ? ` (${count} unread)` : ''}`}>
        <Bell className="h-5 w-5" />
        {count > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{count > 9 ? '9+' : count}</span>
        )}
      </button>
      {open && (
        <div className="animate-in absolute right-0 z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white shadow-pop">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold">Notifications</p>
            {count > 0 && <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => markAll.mutate()}>Mark all read</button>}
          </div>
          <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
            {(list.data?.rows ?? []).length === 0 && <li className="px-4 py-8 text-center text-sm text-slate-500">You're all caught up</li>}
            {(list.data?.rows ?? []).map((n) => (
              <li key={n.id}>
                <button type="button" className="flex w-full gap-3 px-4 py-3 text-left hover:bg-slate-50"
                  onClick={() => { void api.db.rpc('mark_notifications_read', { p_ids: [n.id] }); setOpen(false); if (n.link) navigate(n.link); }}>
                  <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-brand-500')} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-800">{n.title}</span>
                    {n.body && <span className="block truncate text-xs text-slate-500">{n.body}</span>}
                    <span className="block text-[11px] text-slate-400">{fmtRelative(n.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <Link to="/app/notifications" onClick={() => setOpen(false)} className="block border-t border-slate-100 px-4 py-2.5 text-center text-sm font-medium text-brand-700 hover:bg-slate-50">View all</Link>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, signOut } = useSession();
  const { companies, companyId } = useCompany();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const navigate = useNavigate();
  const role = companies.find((c) => c.id === companyId)?.role_name;
  const name = user?.fullName || user?.email;
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-lg p-1 hover:bg-slate-100" aria-label="Account menu" aria-expanded={open}>
        <Avatar name={name} size="sm" />
        <span className="hidden text-left md:block">
          <span className="block max-w-[140px] truncate text-sm font-medium leading-tight text-slate-800">{name}</span>
          <span className="block max-w-[140px] truncate text-xs leading-tight text-slate-500">{role}</span>
        </span>
      </button>
      {open && (
        <div role="menu" className="animate-in absolute right-0 z-40 mt-2 w-60 rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop">
          <div className="border-b border-slate-100 px-3 py-2">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-slate-500">{user?.email}</p>
          </div>
          <Link role="menuitem" to="/app/profile" onClick={() => setOpen(false)} className="mt-1 flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-slate-50">
            <UserCircle className="h-4 w-4" /> My profile
          </Link>
          <button role="menuitem" type="button" onClick={async () => { await signOut(); navigate('/login'); }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-600 hover:bg-rose-50">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function AppLayout() {
  const { user, loading } = useSession();
  const { companies, companiesLoading, ready, isSuperAdmin, company } = useCompany();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);

  if (loading || (user && (companiesLoading || !ready))) return <div className="flex min-h-screen items-center justify-center"><PageLoader label="Loading your workspace…" /></div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (!companies.length) return <Navigate to={isSuperAdmin ? '/admin' : '/onboarding/company'} replace />;

  return (
    <ChatProvider>
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block"><Sidebar /></aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/60" onClick={() => setMobileOpen(false)} aria-hidden />
          <div className="slide-in-right absolute inset-y-0 left-0 w-72 max-w-[85vw]" style={{ animationName: 'none' }}>
            <button type="button" className="absolute right-3 top-4 z-10 rounded-lg p-1.5 text-slate-300 hover:bg-white/10" onClick={() => setMobileOpen(false)} aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
          <button type="button" className="btn-ghost p-2 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <CompanySwitcher />
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {company?.careers_enabled && (
              <a href={`/careers/${company.slug}`} target="_blank" rel="noreferrer" className="btn-ghost hidden text-xs sm:inline-flex">Careers page ↗</a>
            )}
            <ThemeToggle />
            <NotificationBell />
            <UserMenu />
          </div>
        </header>
        {company?.status === 'suspended' && (
          <div className="bg-rose-50 px-6 py-2 text-sm text-rose-700">This company is suspended. Contact the platform administrator.</div>
        )}
        <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8"><Outlet /></main>
      </div>
    </div>
    </ChatProvider>
  );
}

/** Renders children only when the user has one of the permissions. */
export function RequirePermission({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useCompany();
  if (!can(perm)) {
    return (
      <div className="card mx-auto mt-10 max-w-lg p-10 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600"><ShieldCheck className="h-6 w-6" /></div>
        <h1 className="text-lg font-semibold">You don't have access to this page</h1>
        <p className="mt-1 text-sm text-slate-500">Ask your company administrator to grant you the required permission.</p>
        <Link to="/app" className="btn-primary mt-5">Back to dashboard</Link>
      </div>
    );
  }
  return <>{children}</>;
}
