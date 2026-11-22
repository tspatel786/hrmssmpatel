// Unsaved form drafts: a half-filled form survives closing the dialog, a refresh or switching pages.
// Stored per user, company and form in localStorage (this browser only). Cleared after a successful save
// or "Discard draft". Sensitive fields (bank account, PAN, passwords) are never written to the browser.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldValues, UseFormReturn } from 'react-hook-form';
import { useCompanyId, useSession } from '@/contexts/session';

const SENSITIVE = /bank_account|pan_number|password|aadhaar|token/i;
const PREFIX = 'hrms-draft:';

function strip(values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (!SENSITIVE.test(k)) out[k] = v;
  return out;
}

export function useFormDraft<T extends FieldValues>(form: UseFormReturn<T>, draftKey: string | null, open: boolean, defaults: T) {
  const { user } = useSession();
  const companyId = useCompanyId();
  const key = draftKey && user ? `${PREFIX}${user.id}:${companyId ?? '-'}:${draftKey}` : null;
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoring = useRef(false);

  // on open: defaults, overlaid with a saved draft if there is one
  useEffect(() => {
    if (!open) return;
    let draft: { at: string; values: Record<string, unknown> } | null = null;
    if (key) {
      try {
        const raw = localStorage.getItem(key);
        draft = raw ? JSON.parse(raw) : null;
      } catch {
        draft = null;
      }
    }
    restoring.current = true;
    form.reset((draft ? { ...defaults, ...draft.values } : defaults) as T);
    restoring.current = false;
    setRestoredAt(draft?.at ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  // while open: save edits (debounced), only after the user changed something
  useEffect(() => {
    if (!open || !key) return;
    const sub = form.watch((values) => {
      if (restoring.current || !form.formState.isDirty) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        try {
          localStorage.setItem(key, JSON.stringify({ at: new Date().toISOString(), values: strip(values as Record<string, unknown>) }));
        } catch {
          /* storage full or blocked: drafts are a convenience only */
        }
      }, 400);
    });
    return () => {
      sub.unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, key, form]);

  const clearDraft = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (key) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    setRestoredAt(null);
  }, [key]);

  const discardDraft = useCallback(() => {
    clearDraft();
    // reset() leaves fields missing from the defaults untouched: give every current field an explicit empty value
    const blank: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(form.getValues() as Record<string, unknown>)) {
      const d = (defaults as Record<string, unknown>)[k];
      blank[k] = d !== undefined ? d : Array.isArray(v) ? [] : typeof v === 'boolean' ? false : '';
    }
    restoring.current = true;
    form.reset(blank as T);
    restoring.current = false;
  }, [clearDraft, form, defaults]);

  return { restoredAt, clearDraft, discardDraft };
}

/** Removes every saved draft of the current browser (used on sign-out so the next person never sees them). */
export function clearAllDrafts() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}
