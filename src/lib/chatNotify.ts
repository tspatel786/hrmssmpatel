// Chat notifications: Web Audio chime (no assets, no paid APIs), browser notifications,
// and cross-tab de-duplication so a message produces exactly one sound/notification.

let ctx: AudioContext | null = null;
let unlocked = false;

/** Browsers block audio until a user gesture: create/resume the AudioContext on the first interaction. */
export function installAudioUnlock() {
  if (typeof window === 'undefined' || unlocked) return;
  const unlock = () => {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = ctx ?? new AC();
      void ctx.resume().then(() => {
        unlocked = ctx?.state === 'running';
      });
    } catch {
      /* audio unavailable */
    }
    if (unlocked) {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    }
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

export const audioReady = () => unlocked && ctx?.state === 'running';

/** Short, pleasant two-note chime synthesized with the Web Audio API. Returns false if audio is locked. */
export function playChime(): boolean {
  if (!ctx) return false;
  if (ctx.state !== 'running') {
    // a gesture already happened (ctx exists) but the context was suspended (e.g. tab backgrounded): resume, then play
    const c = ctx;
    void c.resume().then(() => c.state === 'running' && synth(c));
    return true;
  }
  synth(ctx);
  return true;
}

function synth(ctx: AudioContext) {
  const now = ctx.currentTime;
  const notes: [number, number][] = [[880, 0], [1318.5, 0.11]]; // A5 → E6
  for (const [freq, offset] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.32);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.35);
  }
  // exposed for automated tests (counts chimes actually synthesized in this tab)
  (window as unknown as { __hrmsChimeCount?: number }).__hrmsChimeCount = ((window as unknown as { __hrmsChimeCount?: number }).__hrmsChimeCount ?? 0) + 1;
}

const SEEN_KEY = 'hrms-chat-notified';
function readSeen(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function claimLocal(id: string): boolean {
  const seen = readSeen();
  if (seen.includes(id)) return false;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen.slice(-199), id]));
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * Atomically claims the right to notify for a message across all tabs of this browser.
 * Uses the Web Locks API to serialize check-and-set on a shared localStorage set.
 */
export async function claimNotification(messageId: string): Promise<boolean> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks?.request) return locks.request('hrms-chat-notify', () => claimLocal(messageId));
  return claimLocal(messageId);
}

export function browserNotificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function requestBrowserPermission(): Promise<NotificationPermission> {
  if (!browserNotificationsSupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

export function showBrowserNotification(title: string, body: string, tag: string, onClick: () => void) {
  if (!browserNotificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag, icon: '/logo-mark.png' });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    /* some browsers require a service worker for notifications */
  }
}
