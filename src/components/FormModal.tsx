import { zodResolver } from '@hookform/resolvers/zod';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Controller, useForm, type DefaultValues, type FieldValues, type Path } from 'react-hook-form';
import type { ZodType } from 'zod';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, type Option } from './ui';

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
            control = <Select {...common} options={f.options ?? []} placeholder={f.required ? 'Select…' : '— None —'} {...form.register(f.name)} />;
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
  open, onClose, title, description, schema, fields, defaultValues, onSubmit, submitLabel = 'Save', size = 'lg', children,
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
}) {
  const form = useForm<T>({ resolver: zodResolver(schema), defaultValues });
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      form.reset(defaultValues);
      setError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = form.handleSubmit(async (v) => {
    setError('');
    try {
      await onSubmit(v);
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
        {error && <div role="alert" className="mb-4 rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{error}</div>}
        <FormFields fields={fields} form={form} />
        {children}
      </form>
    </Modal>
  );
}
