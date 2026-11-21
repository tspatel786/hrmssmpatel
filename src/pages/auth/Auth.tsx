import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, RotateCcw } from 'lucide-react';
import { forwardRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { Logo } from '@/components/Logo';
import { Button, Field, Input } from '@/components/ui';
import { useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { config, DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/lib/config';

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <div className="relative hidden w-[44%] flex-col justify-between overflow-hidden border-r border-brand-500/15 bg-ink p-12 text-white lg:flex">
        <div className="absolute inset-0 bg-[radial-gradient(70%_60%_at_20%_10%,rgba(212,175,55,0.22),transparent)]" />
        <Link to="/" className="relative"><Logo size={48} nameClassName="text-white" /></Link>
        <div className="relative">
          <p className="font-display text-3xl font-semibold leading-snug">“We cut our time-to-hire in half and onboard new joiners in <span className="text-gold-gradient">a single afternoon.</span>”</p>
          <p className="mt-4 text-sm text-ink-muted">Recruitment · Onboarding · Attendance · Leave · Payroll</p>
        </div>
        <p className="relative text-xs text-ink-muted">Enterprise HRMS by {config.companyName} · Secured with row-level multi-tenant isolation.</p>
      </div>
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-8 block lg:hidden"><Logo size={40} /></Link>
          <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-6 text-center text-sm text-slate-500">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

const PasswordInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function PasswordInput(props, ref) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input {...props} ref={ref} type={show ? 'text' : 'password'} className="pr-10" />
      <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600" onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
});

/** Only allow same-origin relative paths for post-login redirects (blocks //host and /\host open redirects). */
export function safeNext(next: string | null): string {
  // must start with a single "/", never "//" or "/\", and contain no backslashes or whitespace
  if (!next || !/^\/(?![/\\])[^\s\\]*$/.test(next)) return '/app';
  return next;
}

const loginSchema = z.object({ email: z.string().trim().email('Enter a valid email'), password: z.string().min(1, 'Password is required') });

export function Login() {
  const { user, setUser } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: params.get('email') ?? '', password: params.get('email') && config.mode === 'demo' ? DEMO_PASSWORD : '' },
  });
  const [error, setError] = useState('');
  if (user) return <Navigate to={next} replace />;

  const onSubmit = form.handleSubmit(async (v) => {
    setError('');
    try {
      const u = await api.auth.signIn(v.email, v.password);
      setUser(u);
      navigate(next, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    }
  });

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your HRMS workspace"
      footer={<>New here? <Link to="/signup" className="font-medium text-brand-700 hover:underline">Create an account</Link></>}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{error}</div>}
        <Field label="Work email" error={form.formState.errors.email?.message} htmlFor="email">
          <Input id="email" type="email" autoComplete="email" invalid={!!form.formState.errors.email} {...form.register('email')} />
        </Field>
        <Field label="Password" error={form.formState.errors.password?.message} htmlFor="password">
          <PasswordInput id="password" autoComplete="current-password" invalid={!!form.formState.errors.password} {...form.register('password')} />
        </Field>
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-sm font-medium text-brand-700 hover:underline">Forgot password?</Link>
        </div>
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Sign in</Button>
      </form>
      {config.mode === 'demo' && <DemoAccounts onPick={(e) => { form.setValue('email', e); form.setValue('password', DEMO_PASSWORD); }} />}
    </AuthShell>
  );
}

function DemoAccounts({ onPick }: { onPick: (email: string) => void }) {
  const [resetting, setResetting] = useState(false);
  return (
    <div className="mt-8 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Demo accounts · password {DEMO_PASSWORD}</p>
      <div className="mt-2 grid gap-1">
        {DEMO_ACCOUNTS.map((a) => (
          <button key={a.email} type="button" onClick={() => onPick(a.email)} className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-white">
            <span className="font-medium text-slate-700">{a.role}</span>
            <span className="text-xs text-slate-500">{a.email}</span>
          </button>
        ))}
      </div>
      <button type="button" disabled={resetting} className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-rose-600"
        onClick={async () => {
          setResetting(true);
          const { resetLocalDatabase } = await import('@/lib/backend/local');
          await resetLocalDatabase();
          window.location.reload();
        }}>
        <RotateCcw className="h-3.5 w-3.5" /> {resetting ? 'Resetting…' : 'Reset demo data'}
      </button>
    </div>
  );
}

const signupSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Enter your full name').max(80),
    email: z.string().trim().email('Enter a valid email'),
    password: z.string().min(8, 'At least 8 characters').regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });

export function Signup() {
  const { user, setUser } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [confirmSent, setConfirmSent] = useState(false);
  const form = useForm<z.infer<typeof signupSchema>>({ resolver: zodResolver(signupSchema), defaultValues: { email: params.get('email') ?? '' } });
  if (user) return <Navigate to="/app" replace />;

  const onSubmit = form.handleSubmit(async (v) => {
    setError('');
    try {
      const res = await api.auth.signUp(v.email, v.password, v.fullName);
      if (res.needsConfirmation) {
        setConfirmSent(true);
        return;
      }
      setUser(res.user);
      toast.success('Account created');
      navigate('/app', { replace: true });
    } catch (e) {
      setError((e as Error).message);
    }
  });

  if (confirmSent) {
    return (
      <AuthShell title="Check your inbox" subtitle="We sent a confirmation link to your email. Click it to activate your account, then sign in.">
        <Link to="/login" className="btn-primary w-full">Go to sign in</Link>
      </AuthShell>
    );
  }
  const e = form.formState.errors;
  return (
    <AuthShell title="Create your account" subtitle="Start a company workspace or accept an invitation"
      footer={<>Already have an account? <Link to="/login" className="font-medium text-brand-700 hover:underline">Sign in</Link></>}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{error}</div>}
        <Field label="Full name" error={e.fullName?.message} htmlFor="fullName"><Input id="fullName" autoComplete="name" invalid={!!e.fullName} {...form.register('fullName')} /></Field>
        <Field label="Work email" error={e.email?.message} htmlFor="email" hint="Invited? Use the email address the invitation was sent to.">
          <Input id="email" type="email" autoComplete="email" invalid={!!e.email} {...form.register('email')} />
        </Field>
        <Field label="Password" error={e.password?.message} htmlFor="password"><PasswordInput id="password" autoComplete="new-password" invalid={!!e.password} {...form.register('password')} /></Field>
        <Field label="Confirm password" error={e.confirm?.message} htmlFor="confirm"><PasswordInput id="confirm" autoComplete="new-password" invalid={!!e.confirm} {...form.register('confirm')} /></Field>
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Create account</Button>
      </form>
    </AuthShell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'sent'>('idle');
  const [error, setError] = useState('');
  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a secure link to set a new password."
      footer={<Link to="/login" className="font-medium text-brand-700 hover:underline">Back to sign in</Link>}>
      {state === 'sent' ? (
        <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">If an account exists for {email}, a reset link has been sent.</div>
      ) : (
        <form className="space-y-4" onSubmit={async (ev) => {
          ev.preventDefault();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setError('Enter a valid email'); return; }
          setError('');
          setState('loading');
          try {
            await api.auth.requestPasswordReset(email, `${window.location.origin}/reset-password`);
            setState('sent');
          } catch (e) {
            setError((e as Error).message);
            setState('idle');
          }
        }} noValidate>
          {error && <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{error}</div>}
          <Field label="Email" htmlFor="email"><Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" className="w-full" loading={state === 'loading'}>Send reset link</Button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPassword() {
  const navigate = useNavigate();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  return (
    <AuthShell title="Choose a new password">
      <form className="space-y-4" onSubmit={async (ev) => {
        ev.preventDefault();
        if (pw.length < 8 || !/\d/.test(pw) || !/[A-Za-z]/.test(pw)) { setError('At least 8 characters with letters and numbers'); return; }
        setLoading(true);
        try {
          await api.auth.updatePassword(pw);
          toast.success('Password updated');
          navigate('/app');
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setLoading(false);
        }
      }} noValidate>
        {error && <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{error}</div>}
        <Field label="New password" htmlFor="pw"><PasswordInput id="pw" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
        <Button type="submit" className="w-full" loading={loading}>Update password</Button>
      </form>
    </AuthShell>
  );
}
