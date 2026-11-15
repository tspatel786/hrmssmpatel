import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/backend';
import { claimNotification, playChime, showBrowserNotification } from '@/lib/chatNotify';
import { useCompany, useSession } from './session';

export interface ChatConversation {
  id: string; type: 'direct' | 'group'; name: string; description: string | null; image_url: string | null; last_message_at: string;
  muted: boolean; my_role: 'admin' | 'member'; unread_count: number; last_message_id: string | null; last_message_body: string | null;
  last_message_sender: string | null; last_message_sender_name: string | null; last_message_has_attachments: boolean;
  other_user_id: string | null; other_user_name: string | null; other_user_email: string | null; other_last_seen: string | null; member_count: number;
}
export interface ChatPrefs { sound_enabled: boolean; browser_enabled: boolean }

interface ChatValue {
  conversations: ChatConversation[];
  loading: boolean;
  unreadTotal: number;
  prefs: ChatPrefs;
  savePrefs: (p: Partial<ChatPrefs>) => Promise<void>;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  refresh: () => void;
  /** monotonically increasing counter bumped on every realtime event (pages use it to refetch) */
  tick: number;
}

const ChatCtx = createContext<ChatValue | null>(null);
/** Online = heartbeat within 75 s and not explicitly signed off (status is absent on databases without migration 1200). */
export const isOnline = (lastSeen?: string | null, status?: string | null) =>
  !!lastSeen && status !== 'offline' && Date.now() - new Date(lastSeen).getTime() < 75_000;

export function ChatProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const { companyId } = useCompany();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const snapshot = useRef<Map<string, string | null> | null>(null);

  const listKey = ['chat-conversations', companyId, user?.id];
  const list = useQuery({
    queryKey: listKey,
    enabled: !!companyId && !!user,
    queryFn: () => api.db.rpc<ChatConversation[]>('chat_my_conversations', { p_company: companyId }),
    refetchInterval: 30_000,
  });
  const prefsQ = useQuery({
    queryKey: ['chat-prefs', user?.id],
    enabled: !!user,
    queryFn: async () => (await api.db.get<ChatPrefs>('chat_notification_preferences', user!.id, 'user_id')) ?? { sound_enabled: true, browser_enabled: false },
  });
  const prefs = prefsQ.data ?? { sound_enabled: true, browser_enabled: false };
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const savePrefs = useCallback(async (p: Partial<ChatPrefs>) => {
    if (!user) return;
    const next = { ...prefsRef.current, ...p };
    const existing = await api.db.get('chat_notification_preferences', user.id, 'user_id');
    if (existing) await api.db.update('chat_notification_preferences', user.id, { ...next, updated_at: new Date().toISOString() }, 'user_id');
    else await api.db.insert('chat_notification_preferences', { user_id: user.id, ...next });
    await qc.invalidateQueries({ queryKey: ['chat-prefs'] });
  }, [qc, user]);


  // realtime: any chat change → refetch list + bump tick for open views
  useEffect(() => {
    if (!companyId || !user) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = api.realtime.subscribe(`chat-${companyId}`, [
      // after migration 1200: chat_conversations (touched on reactions/receipts/membership) + company_realtime_signals (announcements)
      'chat_messages', 'chat_conversations', 'chat_typing_status', 'company_realtime_signals',
      // pre-1200 databases still publish these directly
      'chat_participants', 'chat_reactions', 'announcements',
    ], () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setTick((t) => t + 1);
        void qc.invalidateQueries({ queryKey: ['chat-conversations'] });
      }, 120);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [companyId, user, qc]);

  // presence heartbeat (online / away when tab hidden)
  useEffect(() => {
    if (!user) return;
    const beat = () => void api.db.rpc('chat_heartbeat', { p_status: document.hidden ? 'away' : 'online' }).catch(() => undefined);
    beat();
    const t = setInterval(beat, 30_000);
    // best effort: tell colleagues we left when the tab/app is closed (otherwise presence expires after 75 s)
    const leave = () => void api.db.rpc('chat_heartbeat', { p_status: 'offline' }).catch(() => undefined);
    document.addEventListener('visibilitychange', beat);
    window.addEventListener('pagehide', leave);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', beat);
      window.removeEventListener('pagehide', leave);
    };
  }, [user]);

  // detect new incoming messages by diffing each conversation's latest message id
  useEffect(() => {
    const rows = list.data;
    if (!rows || !user) return;
    const prev = snapshot.current;
    const next = new Map(rows.map((c) => [c.id, c.last_message_id]));
    snapshot.current = next;
    if (!prev) return; // first load: just take a snapshot
    const incoming = rows.filter((c) => c.last_message_id && prev.get(c.id) !== c.last_message_id && c.last_message_sender && c.last_message_sender !== user.id);
    if (!incoming.length) return;
    void api.db.rpc('chat_mark_delivered', { p_company: companyId }).catch(() => undefined);
    for (const c of incoming) {
      if (c.muted) continue;
      const viewing = activeRef.current === c.id && document.visibilityState === 'visible';
      if (viewing) continue;
      void claimNotification(c.last_message_id!).then((mine) => {
        if (!mine) return; // another tab already notified for this message
        if (prefsRef.current.sound_enabled) playChime();
        if (prefsRef.current.browser_enabled && (document.hidden || !document.hasFocus())) {
          const title = c.type === 'group' ? `${c.last_message_sender_name} in ${c.name}` : c.last_message_sender_name ?? 'New message';
          showBrowserNotification(title, c.last_message_has_attachments && !c.last_message_body ? '📎 Attachment' : c.last_message_body ?? '', `chat-${c.id}`,
            () => navigate(`/app/communication?c=${c.id}`));
        }
      });
    }
  }, [list.data, user, companyId, navigate]);

  const conversations = useMemo(() => list.data ?? [], [list.data]);
  const unreadTotal = conversations.reduce((a, c) => a + (c.muted ? 0 : Number(c.unread_count)), 0);
  const value: ChatValue = {
    conversations, loading: list.isLoading, unreadTotal, prefs, savePrefs, activeId, setActiveId, tick,
    refresh: () => void qc.invalidateQueries({ queryKey: ['chat-conversations'] }),
  };
  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>;
}

export function useChat() {
  const v = useContext(ChatCtx);
  if (!v) throw new Error('useChat outside ChatProvider');
  return v;
}
