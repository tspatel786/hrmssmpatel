import { zodResolver } from '@hookform/resolvers/zod';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Controller, useForm, useWatch, type DefaultValues, type FieldValues, type Path, type UseFormReturn } from 'react-hook-form';
import type { ZodType } from 'zod';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, type Option } from './ui';
import { fmtDateTime } from '@/lib/format';
import { useFormDraft } from '@/lib/formDraft';

export interface FieldDef<T> {
  name: Path<T>;
  label: string;
  type?: 'text' | 'email' | 'number' | 'date' | 'datetime-local' | 'time' | 'textarea' | 'select' | 'checkbox' | 'tags' | 'color' | 'url' | 'tel';
  options?: Option[];
  placeholder?: string;
  hint?: string;
  required?: boolean;
  span?: 1 | 2;
  rows?: number;
  step?: string;
  min?: number | string;
  max?: number | string;
  hidden?: boolean;
  disabled?: boolean;
  /** Dependent dropdown: options computed from the other values (e.g. designations of the selected department). */
  filterOptions?: (values: Record<string, unknown>) => Option[];
}

/** A dropdown whose options depend on other fields; a choice that no longer fits is cleared. */
function DependentSelect<T extends FieldValues>({ field, form, common }: {
  field: FieldDef<T>; form: UseFormReturn<T>; common: { id: string; invalid: boolean; disabled?: boolean; placeholder?: string };
}) {
  const values = useWatch({ control: form.control }) as Record<string, unknown>;
  const options = field.filterOptions!(values);
  const current = values[field.name as string];
  const known = options.length > 0 || (field.options?.length ?? 0) > 0;
  useEffect(() => {
    if (known && current && !options.some((o) => o.value === String(current))) form.setValue(field.name, '' as never, { shouldDirty: true });
  }, [known, current, options, form, field.name]);
  return <Select {...common} options={options} placeholder={field.required ? 'Select…' : '— None —'} {...form.register(field.name)} />;
}

/** "Draft restored" note with a way to start over. */
export function DraftNotice({ restoredAt, onDiscard }: { restoredAt: string | null; onDiscard: () => void }) {
  if (!restoredAt) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800" role="status">
      <span>Unsaved entries from {fmtDateTime(restoredAt)} were restored.</span>
      <button type="button" className="font-medium underline hover:no-underline" onClick={onDiscard}>Discard draft</button>
    </div>
  );
}

/** Converts '' to null and trims strings so optional DB columns are stored as NULL. */
export function clean<T extends Record<string, unknown>>(v: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = typeof val === 'string' ? (val.trim() === '' ? null : val.trim()) : val;
  return out as T;
}

export function FormFields<T extends FieldValues>({ fields, form }: { fields: FieldDef<T>[]; form: ReturnType<typeof useForm<T>> }) {
  const errors = form.formState.errors as Record<string, { message?: string }>;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {fields.filter((f) => !f.hidden).map((f) => {
        const err = errors[f.name]?.message;
        const id = `f-${String(f.name)}`;
        const common = { id, invalid: !!err, disabled: f.disabled, placeholder: f.placeholder };
        let control;
        switch (f.type) {
          case 'textarea':
            control = <Textarea {...common} rows={f.rows ?? 4} {...form.register(f.name)} />;
            break;
          case 'select':
            control = f.filterOptions
              ? <DependentSelect field={f} form={form} common={common} />
              : <Select {...common} options={f.options ?? []} placeholder={f.required ? 'Select…' : '— None —'} {...form.register(f.name)} />;
            break;
          case 'checkbox':
            control = (
              <Controller control={form.control} name={f.name} render={({ field }) => (
                <Checkbox label={f.label} checked={!!field.value} onChange={field.onChange} disabled={f.disabled} description={f.hint} />
              )} />
            );
            break;
          case 'tags':
            control = (
              <Controller control={form.control} name={f.name} render={({ field }) => (
                <Input {...common} value={Array.isArray(field.value) ? field.value.join(', ') : field.value ?? ''}
                  onChange={(e) => field.onChange(e.target.value.split(',').map((s) => s.trimStart()))}
                  onBlur={() => field.onChange((Array.isArray(field.value) ? field.value : []).map((s: string) => s.trim()).filter(Boolean))} />
              )} />
            );
            break;
          default:
            control = <Input {...common} type={f.type ?? 'text'} step={f.step} min={f.min} max={f.max} {...form.register(f.name)} />;
        }
        return (
          <div key={String(f.name)} className={clsx(f.span === 2 || f.type === 'textarea' ? 'sm:col-span-2' : '')}>
            {f.type === 'checkbox' ? control : (
              <Field label={f.label} required={f.required} error={err} hint={f.hint} htmlFor={id}>{control}</Field>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function FormModal<T extends FieldValues>({
  open, onClose, title, description, schema, fields, defaultValues, onSubmit, submitLabel = 'Save', size = 'lg', children, draftKey,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  schema: ZodType<T, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  fields: FieldDef<T>[];
  defaultValues: DefaultValues<T>;
  onSubmit: (values: T) => Promise<unknown>;
  submitLabel?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  children?: React.ReactNode;
  /** Unsaved entries are kept under this key (default: the title + record id); null turns drafts off. */
  draftKey?: string | null;
}) {
  const form = useForm<T>({ resolver: zodResolver(schema), defaultValues });
  const [error, setError] = useState('');
  const recordId = (defaultValues as Record<string, unknown> | undefined)?.id;
  const key = draftKey === undefined ? `${title}:${recordId ?? 'new'}` : draftKey;
  const draft = useFormDraft(form, key, open, defaultValues as T);
  useEffect(() => {
    if (open) setError('');
  }, [open]);
  const submit = form.handleSubmit(async (v) => {
    setError('');
    try {
      await onSubmit(v);
      draft.clearDraft();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  });
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size={size}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.formState.isSubmitting}>Cancel</Button>
          <Button type="submit" form="form-modal" loading={form.formState.isSubmitting}>{submitLabel}</Button>
        </>
      }>
      <form id="form-modal" onSubmit={submit} noValidate>
        <DraftNotice restoredAt={draft.restoredAt} onDiscard={draft.discardDraft} />
        {error && <div role="alert" className="mb-4 rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{error}</div>}
        <FormFields fields={fields} form={form} />
        {children}
      </form>
    </Modal>
  );
}
