import { zodResolver } from '@hookform/resolvers/zod';
import { LogOut } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button, Field, Input, PageLoader, Select } from '@/components/ui';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { slugify } from '@/lib/format';

const schema = z.object({
  name: z.string().trim().min(2, 'Company name is required').max(120),
  slug: z.string().trim().regex(/^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$/, '3–50 lowercase letters, numbers or hyphens'),
  email: z.string().trim().email('Enter a valid email').or(z.literal('')),
  country: z.string().min(2),
});

export function CreateCompany() {
  const { user, loading, signOut } = useSession();
  const { companies, switchCompany, refresh } = useCompany();
  const navigate = useNavigate();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', slug: '', email: user?.email ?? '', country: 'India' } });
  const name = form.watch('name');
  useEffect(() => {
    if (!form.formState.dirtyFields.slug) form.setValue('slug', slugify(name));
  }, [name, form]);

  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login?next=/onboarding/company" replace />;
  const e = form.formState.errors;
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      const id = await api.db.rpc<string>('create_company', { p_name: v.name, p_slug: v.slug, p_email: v.email || null, p_country: v.country });
      await refresh();
      switchCompany(id);
      toast.success('Company created — welcome aboard!');
      navigate('/app', { replace: true });
    } catch (err) {
      toast.error((err as Error).message);
    }
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center justify-between">
          <Logo size={36} nameClassName="text-base" />
          <button type="button" className="btn-ghost text-sm" onClick={async () => { await signOut(); navigate('/login'); }}><LogOut className="h-4 w-4" /> Sign out</button>
        </div>
        <div className="card p-8">
          <h1 className="text-xl font-semibold">Set up your company</h1>
          <p className="mt-1 text-sm text-slate-500">
            {companies.length ? 'Create another company workspace.' : 'You are not a member of any company yet. Create one, or ask your HR admin to invite '}
            {!companies.length && <strong>{user.email}</strong>}.
          </p>
          <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
            <Field label="Company name" required error={e.name?.message} htmlFor="name"><Input id="name" invalid={!!e.name} {...form.register('name')} /></Field>
            <Field label="Careers page URL" required error={e.slug?.message} htmlFor="slug" hint={`${window.location.origin}/careers/${form.watch('slug') || 'your-company'}`}>
              <Input id="slug" invalid={!!e.slug} {...form.register('slug')} />
            </Field>
            <Field label="Company email" error={e.email?.message} htmlFor="cemail"><Input id="cemail" type="email" invalid={!!e.email} {...form.register('email')} /></Field>
            <Field label="Country" htmlFor="country">
              <Select id="country" options={['India', 'United States', 'United Kingdom', 'Singapore', 'United Arab Emirates', 'Australia', 'Germany', 'Canada'].map((c) => ({ value: c, label: c }))} {...form.register('country')} />
            </Field>
            <p className="text-xs text-slate-500">We'll set up default roles, departments, leave types, onboarding checklist and email templates you can customise later.</p>
            <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Create company</Button>
          </form>
        </div>
        {companies.length > 0 && <p className="mt-4 text-center text-sm"><Link to="/app" className="text-brand-700 hover:underline">← Back to dashboard</Link></p>}
      </div>
    </div>
  );
}
