const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || '';
const forced = (import.meta.env.VITE_BACKEND_MODE as string | undefined)?.trim();

export const config = {
  supabaseUrl: url,
  supabaseAnonKey: anonKey,
  mode: (forced === 'demo' || forced === 'supabase' ? forced : url && anonKey ? 'supabase' : 'demo') as 'supabase' | 'demo',
  publicAppUrl: ((import.meta.env.VITE_PUBLIC_APP_URL as string | undefined)?.trim() || '').replace(/\/$/, ''),
  appName: 'TalentFlow HRMS',
};

export function appBaseUrl(): string {
  return config.publicAppUrl || window.location.origin;
}

export const DEMO_PASSWORD = 'Demo@12345';
export const DEMO_ACCOUNTS = [
  { email: 'hr@nimbus.test', role: 'Company Admin (HR Head)', name: 'Neha Kapoor' },
  { email: 'recruiter@nimbus.test', role: 'Recruiter', name: 'Rahul Mehta' },
  { email: 'manager@nimbus.test', role: 'Hiring Manager', name: 'Arjun Rao' },
  { email: 'payroll@nimbus.test', role: 'Payroll Manager', name: 'Kavya Iyer' },
  { email: 'employee@nimbus.test', role: 'Employee', name: 'Sneha Patil' },
  { email: 'admin@platform.test', role: 'SaaS Super Admin', name: 'Platform Admin' },
];
