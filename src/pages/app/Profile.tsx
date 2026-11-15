import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, Badge, Button, Card, Field, Input, PageHeader, PageLoader } from '@/components/ui';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { useAction, useRecord, useRpc } from '@/lib/hooks';

export function Profile() {
  const { user, setUser } = useSession();
  const { companyId, companies } = useCompany();
  const profile = useRecord<{ id: string; full_name: string | null; phone: string | null; email: string }>('profiles', user?.id);
  const me = useRpc<{ employee: { id: string; name: string; code: string; designation: string | null; department: string | null } | null }>('my_dashboard', companyId ? { p_company: companyId } : null);
  const [form, setForm] = useState({ full_name: '', phone: '' });
  const [pw, setPw] = useState({ next: '', confirm: '' });
  const [pwError, setPwError] = useState('');
  useEffect(() => {
    if (profile.data) setForm({ full_name: profile.data.full_name ?? '', phone: profile.data.phone ?? '' });
  }, [profile.data]);
  const save = useAction(() => {
    if (form.full_name.trim().length < 2) throw new Error('Name must be at least 2 characters');
    if (form.phone && !/^[+0-9 ()-]{7,20}$/.test(form.phone)) throw new Error('Enter a valid phone number');
    return api.db.update('profiles', user!.id, { full_name: form.full_name.trim(), phone: form.phone.trim() || null });
  }, { success: 'Profile updated', onSuccess: () => user && setUser({ ...user, fullName: form.full_name.trim() }) });
  const change = useAction(() => api.auth.updatePassword(pw.next), { success: 'Password changed', onSuccess: () => setPw({ next: '', confirm: '' }), silent: true });
  if (profile.isLoading) return <PageLoader />;
  return (
    <>
      <PageHeader title="My profile" description="Your personal account settings." />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Account">
          <div className="mb-5 flex items-center gap-4">
            <Avatar name={form.full_name || user?.email} size="lg" />
            <div><p className="font-semibold">{form.full_name || user?.email}</p><p className="text-sm text-slate-500">{user?.email}</p></div>
          </div>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <Field label="Full name" required htmlFor="pn"><Input id="pn" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
            <Field label="Phone" htmlFor="pp"><Input id="pp" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Email" hint="Contact your administrator to change your login email." className="sm:col-span-2"><Input value={user?.email ?? ''} disabled /></Field>
            <div className="sm:col-span-2"><Button type="submit" loading={save.isPending}>Save profile</Button></div>
          </form>
        </Card>
        <div className="space-y-5">
          <Card title="Employment">
            {me.data?.employee ? (
              <div className="space-y-1 text-sm">
                <p className="font-medium">{me.data.employee.name} <Badge className="ml-1">{me.data.employee.code}</Badge></p>
                <p className="text-slate-500">{me.data.employee.designation ?? '—'} · {me.data.employee.department ?? '—'}</p>
                <Link to={`/app/employees/${me.data.employee.id}`} className="inline-block pt-2 font-medium text-brand-700 hover:underline">View employee profile →</Link>
              </div>
            ) : <p className="text-sm text-slate-500">Your account isn't linked to an employee profile in this company.</p>}
          </Card>
          <Card title="Companies">
            <ul className="space-y-2 text-sm">{companies.map((c) => <li key={c.id} className="flex items-center justify-between"><span>{c.name}</span><Badge tone="blue">{c.role_name}</Badge></li>)}</ul>
          </Card>
          <Card title="Change password">
            <form className="space-y-3" onSubmit={(e) => {
              e.preventDefault();
              setPwError('');
              if (pw.next.length < 8 || !/\d/.test(pw.next) || !/[A-Za-z]/.test(pw.next)) return setPwError('At least 8 characters with letters and numbers');
              if (pw.next !== pw.confirm) return setPwError('Passwords do not match');
              change.mutate(undefined, { onError: (er) => setPwError(er.message) });
            }}>
              {pwError && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{pwError}</p>}
              <Field label="New password" htmlFor="np"><Input id="np" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
              <Field label="Confirm password" htmlFor="cp"><Input id="cp" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
              <Button type="submit" variant="secondary" loading={change.isPending}>Update password</Button>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
