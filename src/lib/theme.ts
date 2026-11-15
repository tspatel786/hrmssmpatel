// Light / dark / system theme. Light stays the default so the existing look is unchanged until a user opts in.
import { useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'hrms-theme';
const listeners = new Set<(p: ThemePref) => void>();

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
}

const systemDark = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
export const resolveTheme = (p: ThemePref) => (p === 'system' ? (systemDark() ? 'dark' : 'light') : p);

export function applyTheme(p: ThemePref = getThemePref()) {
  const dark = resolveTheme(p) === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function setThemePref(p: ThemePref) {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* private mode: theme still applies for this session */
  }
  applyTheme(p);
  listeners.forEach((l) => l(p));
}

/** Call once at startup: applies the saved theme and follows OS changes while on "system". */
export function installTheme() {
  applyTheme();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => getThemePref() === 'system' && applyTheme('system'));
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  useEffect(() => {
    listeners.add(setPref);
    return () => void listeners.delete(setPref);
  }, []);
  return { pref, resolved: resolveTheme(pref), setPref: setThemePref };
}
