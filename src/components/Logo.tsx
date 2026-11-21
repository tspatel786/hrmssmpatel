import clsx from 'clsx';
import { config } from '@/lib/config';

/** S.M.PATEL IT HUB monogram (public/logo-mark.png) with the product name beside it. */
export function Logo({ size = 36, showName = true, className, nameClassName }: { size?: number; showName?: boolean; className?: string; nameClassName?: string }) {
  return (
    <span className={clsx('flex items-center gap-2.5', className)}>
      <img src="/logo-mark.png" alt={showName ? '' : config.appName} width={size} height={size} className="shrink-0 object-contain" style={{ width: size, height: size }} />
      {showName && <span className={clsx('font-display text-lg font-bold tracking-tight', nameClassName)}>{config.appName}</span>}
    </span>
  );
}
