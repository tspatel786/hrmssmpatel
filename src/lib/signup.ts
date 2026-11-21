import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/backend';

/**
 * Whether anyone may create their own company (SaaS product) or the deployment is one organisation's internal HRMS
 * where people join by invitation only (migration 1700, platform_settings.public_signup).
 * Databases without migration 1700 keep the original behaviour: open.
 */
export function useSignupEnabled(): { enabled: boolean; loading: boolean } {
  const q = useQuery({
    queryKey: ['rpc', 'public_signup_enabled'],
    queryFn: async () => {
      try {
        return (await api.db.rpc<boolean>('public_signup_enabled', {})) !== false;
      } catch {
        return true;
      }
    },
    staleTime: 5 * 60_000,
  });
  return { enabled: q.data ?? true, loading: q.isLoading };
}
