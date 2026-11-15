import { Building2, Loader2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { getBackend } from '@/lib/backend';
import { config } from '@/lib/config';
import { SessionProvider, CompanyProvider } from '@/contexts/session';

/** Waits for the backend (Supabase client or in-browser Postgres) before rendering the app. */
export function AppBoot({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    getBackend()
      .then(() => alive && setState('ready'))
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        setState('error');
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  if (state === 'ready') {
    return (
      <SessionProvider>
        <CompanyProvider>{children}</CompanyProvider>
      </SessionProvider>
    );
  }
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gradient-to-b from-white to-slate-100 px-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white shadow-lg shadow-brand-600/30">
        <Building2 className="h-6 w-6" />
      </span>
      {state === 'loading' ? (
        <>
          <Loader2 className="h-6 w-6 animate-spin text-brand-600" aria-label="Loading" />
          <p className="max-w-sm text-sm text-slate-500">
            {config.mode === 'demo'
              ? 'Starting the demo workspace. The first launch sets up an in-browser database with sample data — this can take a few seconds.'
              : 'Connecting…'}
          </p>
        </>
      ) : (
        <>
          <p className="text-base font-semibold text-slate-900">The application could not start</p>
          <p className="max-w-md text-sm text-slate-500">{error}</p>
          <button type="button" className="btn-primary" onClick={() => { setState('loading'); setAttempt((a) => a + 1); }}>Retry</button>
        </>
      )}
    </div>
  );
}
