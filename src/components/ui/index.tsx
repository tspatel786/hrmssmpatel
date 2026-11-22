import clsx from 'clsx';
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox, Loader2, Search, X } from 'lucide-react';
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { initials } from '@/lib/format';

export { clsx as cx };

// ---------------- Button ----------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(`btn-${variant}`, size === 'sm' && 'btn-sm', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ---------------- Form controls ----------------
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} className={clsx('input', invalid && 'input-error', className)} aria-invalid={invalid || undefined} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, rows = 4, ...rest }, ref) {
    return <textarea ref={ref} rows={rows} className={clsx('input', invalid && 'input-error', className)} aria-invalid={invalid || undefined} {...rest} />;
  },
);

export interface Option {
  value: string;
  label: string;
}
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { options: Option[]; placeholder?: string; invalid?: boolean }>(
  function Select({ options, placeholder, className, invalid, ...rest }, ref) {
    return (
      <select ref={ref} className={clsx('input', invalid && 'input-error', className)} aria-invalid={invalid || undefined} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  },
);

export function Field({ label, error, hint, required, children, className, htmlFor }: {
  label?: string; error?: string; hint?: string; required?: boolean; children: ReactNode; className?: string; htmlFor?: string;
}) {
  // Associate the label with its control even when callers don't pass an id (accessibility + testability).
  const autoId = useId();
  const child = isValidElement<{ id?: string }>(children) ? children : null;
  const id = htmlFor ?? child?.props.id ?? autoId;
  const control = child && !child.props.id && !htmlFor ? cloneElement(child, { id }) : children;
  return (
    <div className={className}>
      {label && (
        <label className="label" htmlFor={id}>
          {label}
          {required && <span className="ml-0.5 text-rose-500" aria-hidden>*</span>}
        </label>
      )}
      {control}
      {error ? <p className="error-text" role="alert">{error}</p> : hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ label, checked, onChange, disabled, description }: {
  label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; description?: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={clsx('flex items-start gap-2.5 text-sm', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium text-slate-800">{label}</span>
        {description && <span className="block text-xs text-slate-500">{description}</span>}
      </span>
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={clsx('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition', checked ? 'bg-brand-600' : 'bg-slate-300', disabled && 'opacity-50')}>
      <span className={clsx('inline-block h-5 w-5 rounded-full bg-white shadow transition', checked ? 'translate-x-5' : 'translate-x-0.5')} />
    </button>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string;
}) {
  return (
    <div className={clsx('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input type="search" className="input pl-9" placeholder={placeholder} value={value} aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ---------------- Display ----------------
export function Card({ children, className, title, actions, padded = true }: {
  children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; padded?: boolean;
}) {
  return (
    <section className={clsx('card', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
          {typeof title === 'string' ? <h2 className="section-title">{title}</h2> : title}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={clsx(padded && 'p-5')}>{children}</div>
    </section>
  );
}

const TONES = {
  gray: 'bg-slate-50 text-slate-700 ring-slate-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  yellow: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
  cyan: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
  orange: 'bg-orange-50 text-orange-700 ring-orange-200',
} as const;
export type Tone = keyof typeof TONES;
export function Badge({ tone = 'gray', children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={clsx('badge', TONES[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

const AVATAR_COLORS = ['bg-blue-100 text-blue-700', 'bg-emerald-100 text-emerald-700', 'bg-violet-100 text-violet-700',
  'bg-amber-100 text-amber-800', 'bg-rose-100 text-rose-700', 'bg-cyan-100 text-cyan-700', 'bg-indigo-100 text-indigo-700'];
export function Avatar({ name, size = 'md', src }: { name?: string | null; size?: 'xs' | 'sm' | 'md' | 'lg'; src?: string | null }) {
  const sizes = { xs: 'h-6 w-6 text-[10px]', sm: 'h-8 w-8 text-xs', md: 'h-9 w-9 text-sm', lg: 'h-14 w-14 text-lg' };
  const color = AVATAR_COLORS[(name ?? '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  if (src) return <img src={src} alt={name ?? ''} className={clsx('rounded-full object-cover', sizes[size])} />;
  return (
    <span className={clsx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', sizes[size], color)} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return <Loader2 className={clsx('h-5 w-5 animate-spin text-brand-600', className)} aria-label={label} role="status" />;
}

export function PageLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-sm text-slate-500" role="status">
      <Spinner className="h-7 w-7" />
      {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-md bg-slate-200/70', className)} aria-hidden />;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">{icon ?? <Inbox className="h-6 w-6" />}</div>
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error ?? 'Something went wrong');
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center" role="alert">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-500"><AlertTriangle className="h-6 w-6" /></div>
      <h3 className="text-sm font-semibold text-slate-900">Could not load data</h3>
      <p className="mt-1 max-w-md text-sm text-slate-500">{msg}</p>
      {onRetry && <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function PageHeader({ title, description, actions, breadcrumb }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-sm text-slate-500">{breadcrumb}</div>}
        <h1 className="truncate text-2xl font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, icon, hint, tone = 'blue', trend }: {
  label: string; value: ReactNode; icon?: ReactNode; hint?: ReactNode; tone?: 'blue' | 'green' | 'violet' | 'amber' | 'rose' | 'cyan'; trend?: { value: number; label?: string };
}) {
  const tones = { blue: 'bg-blue-50 text-blue-600', green: 'bg-emerald-50 text-emerald-600', violet: 'bg-violet-50 text-violet-600',
    amber: 'bg-amber-50 text-amber-600', rose: 'bg-rose-50 text-rose-600', cyan: 'bg-cyan-50 text-cyan-600' };
  return (
    <div className="card card-pad flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <p className="mt-1.5 text-2xl font-semibold text-slate-900">{value}</p>
        {(hint || trend) && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
            {trend && (
              <span className={clsx('font-semibold', trend.value > 0 ? 'text-emerald-600' : trend.value < 0 ? 'text-rose-600' : 'text-slate-500')}>
                {trend.value > 0 ? '▲' : trend.value < 0 ? '▼' : '•'} {Math.abs(trend.value)}%
              </span>
            )}
            {hint}
          </p>
        )}
      </div>
      {icon && <div className={clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', tones[tone])}>{icon}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div className={clsx('scrollbar-thin -mx-1 flex gap-1 overflow-x-auto border-b border-slate-200 px-1', className)} role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" type="button" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={clsx('-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition',
            value === t.value ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}>
          {t.label}
          {t.count !== undefined && (
            <span className={clsx('rounded-full px-1.5 py-0.5 text-[11px]', value === t.value ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-600')}>{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage, onPageSize }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (s: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-600 sm:flex-row">
      <div className="flex items-center gap-3">
        <span>
          {from}–{to} of <span className="font-medium text-slate-900">{total}</span>
        </span>
        {onPageSize && (
          <select className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs" value={pageSize} aria-label="Rows per page"
            onChange={(e) => onPageSize(Number(e.target.value))}>
            {[10, 20, 50, 100].map((s) => <option key={s} value={s}>{s} / page</option>)}
          </select>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button type="button" className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="px-2 text-xs">Page {page} of {pages}</span>
        <button type="button" className="btn-ghost btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---------------- Overlays ----------------
function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', h);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  useEscape(open, onClose);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (open) setTimeout(() => ref.current?.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea,button[data-autofocus]')?.focus(), 30);
  }, [open]);
  if (!open) return null;
  const widths = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="presentation">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={clsx('animate-in relative flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-pop sm:rounded-2xl', widths[size])}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
          <button type="button" className="btn-ghost -mr-2 p-1.5" onClick={onClose} aria-label="Close dialog"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-6 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, children, footer, width = 'max-w-xl' }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string;
}) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50" role="presentation">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" className={clsx('slide-in-right absolute inset-y-0 right-0 flex w-full flex-col bg-white shadow-pop', width)}>
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button type="button" className="btn-ghost -mr-2 p-1.5" onClick={onClose} aria-label="Close panel"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Confirmation dialog with optional required text input (e.g. rejection reason). */
export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', tone = 'primary', loading, input }: {
  open: boolean; onClose: () => void; onConfirm: (text: string) => void; title: string; message?: ReactNode; confirmLabel?: string;
  tone?: 'primary' | 'danger' | 'success'; loading?: boolean; input?: { label: string; required?: boolean; placeholder?: string; multiline?: boolean };
}) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) setText('');
  }, [open]);
  const invalid = !!input?.required && text.trim().length < 3;
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant={tone} loading={loading} disabled={invalid} onClick={() => onConfirm(text.trim())} data-autofocus>{confirmLabel}</Button>
        </>
      }>
      {message && <div className="text-sm text-slate-600">{message}</div>}
      {input && (
        <Field label={input.label} required={input.required} className="mt-4" hint={input.required ? 'Minimum 3 characters' : undefined}>
          {input.multiline ? (
            <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={input.placeholder} rows={3} />
          ) : (
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={input.placeholder} />
          )}
        </Field>
      )}
    </Modal>
  );
}

export function DescriptionList({ items, cols = 2 }: { items: { label: string; value: ReactNode }[]; cols?: 1 | 2 | 3 }) {
  return (
    <dl className={clsx('grid gap-x-6 gap-y-4', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3')}>
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{i.label}</dt>
          <dd className="mt-1 break-words text-sm text-slate-900">{i.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
