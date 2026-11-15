import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/lib/backend';
import type { AuthUser } from '@/lib/backend/types';

export interface CompanySummary {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  primary_color: string;
  status: string;
  role_name: string;
  is_admin: boolean;
}

export interface Company {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  timezone: string;
  currency: string;
  logo_url: string | null;
  primary_color: string;
  careers_enabled: boolean;
  careers_tagline: string | null;
  careers_about: string | null;
  employee_code_prefix: string;
  offer_approval_required: boolean;
  offer_validity_days: number;
  work_start: string;
  work_end: string;
  working_days: number[];
  late_grace_minutes?: number;
  pf_enabled: boolean;
  pf_percent: number;
  professional_tax: number;
  tds_percent: number;
  email_from_name: string | null;
  email_reply_to: string | null;
  status: string;
  plan: string;
  max_employees: number;
}

interface SessionValue {
  user: AuthUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
  setUser: (u: AuthUser | null) => void;
}

const SessionCtx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    let mounted = true;
    api.auth.getUser().then((u) => {
      if (mounted) {
        setUser(u);
        setLoading(false);
      }
    });
    const off = api.auth.onChange((u) => {
      setUser(u);
      qc.clear();
    });
    return () => {
      mounted = false;
      off();
    };
  }, [qc]);

  const signOut = useCallback(async () => {
    await api.auth.signOut();
    setUser(null);
    qc.clear();
  }, [qc]);

  return <SessionCtx.Provider value={{ user, loading, signOut, setUser }}>{children}</SessionCtx.Provider>;
}

export function useSession() {
  const v = useContext(SessionCtx);
  if (!v) throw new Error('useSession outside provider');
  return v;
}

// ---------------- company & permissions ----------------
interface CompanyValue {
  companies: CompanySummary[];
  companiesLoading: boolean;
  /** set when the membership lookup failed: callers must not treat it as "no companies" */
  companiesError: unknown;
  companyId: string | null;
  company: Company | null;
  permissions: Set<string>;
  isSuperAdmin: boolean;
  ready: boolean;
  can: (perm: string | string[]) => boolean;
  switchCompany: (id: string) => void;
  refresh: () => Promise<void>;
}

const CompanyCtx = createContext<CompanyValue | null>(null);
const COMPANY_KEY = 'talentflow-company';

export function CompanyProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      return localStorage.getItem(COMPANY_KEY);
    } catch {
      return null;
    }
  });

  const boot = useQuery({
    queryKey: ['session-boot', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async () => {
      await api.db.rpc('accept_my_invitations').catch(() => 0);
      const [companies, isSuperAdmin] = await Promise.all([
        api.db.rpc<CompanySummary[]>('my_companies'),
        api.db.rpc<boolean>('is_super_admin'),
      ]);
      return { companies, isSuperAdmin };
    },
  });

  const companies = useMemo(() => boot.data?.companies ?? [], [boot.data]);
  const companyId = useMemo(() => {
    if (!companies.length) return null;
    return companies.find((c) => c.id === selected)?.id ?? companies[0].id;
  }, [companies, selected]);

  const details = useQuery({
    queryKey: ['company-context', companyId, user?.id],
    enabled: !!companyId && !!user,
    queryFn: async () => {
      const [company, perms] = await Promise.all([
        api.db.get<Company>('companies', companyId!),
        api.db.rpc<string[]>('my_permissions', { p_company: companyId }),
      ]);
      return { company, perms: new Set(perms ?? []) };
    },
  });

  const switchCompany = useCallback(
    (id: string) => {
      setSelected(id);
      try {
        localStorage.setItem(COMPANY_KEY, id);
      } catch {
        /* ignore */
      }
      if (user) void api.db.update('profiles', user.id, { last_company_id: id }).catch(() => undefined);
      void qc.invalidateQueries();
    },
    [qc, user],
  );

  const permissions = details.data?.perms ?? new Set<string>();
  const value: CompanyValue = {
    companies,
    companiesLoading: boot.isLoading,
    companiesError: boot.isError ? boot.error : null,
    companyId,
    company: details.data?.company ?? null,
    permissions,
    isSuperAdmin: !!boot.data?.isSuperAdmin,
    ready: !boot.isLoading && (!companyId || !details.isLoading),
    can: (perm) => (Array.isArray(perm) ? perm.some((p) => permissions.has(p)) : permissions.has(perm)),
    switchCompany,
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ['session-boot'] });
      await qc.invalidateQueries({ queryKey: ['company-context'] });
    },
  };
  return <CompanyCtx.Provider value={value}>{children}</CompanyCtx.Provider>;
}

export function useCompany() {
  const v = useContext(CompanyCtx);
  if (!v) throw new Error('useCompany outside provider');
  return v;
}

/** Convenience: current company id (asserted non-null inside the app shell). */
export function useCompanyId(): string {
  const { companyId } = useCompany();
  return companyId ?? '';
}
