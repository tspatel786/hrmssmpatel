import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { isSameDay, isToday, isYesterday } from 'date-fns';
import {
  ArrowLeft, Check, CheckCheck, Copy, Download, FileText, Info, Loader2, Paperclip, Pencil, Pin, Reply, Search, Send, Smile, Trash2, X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Avatar, Button, ConfirmDialog, Spinner } from '@/components/ui';
import { isOnline, useChat, type ChatConversation } from '@/contexts/chat';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { downloadBlob } from '@/lib/csv';
import { fileSize, fmtDate, fmtRelative, fmtTime } from '@/lib/format';

export interface DirectoryEntry { user_id: string; full_name: string; email: string; role_name: string; employee_code: string | null; department_name: string | null; designation_title: string | null; last_seen_at: string | null; presence_status?: string | null }
interface Att { id: string; path: string; name: string; mime: string; size: number }
export interface Msg {
  id: string; conversation_id: string; sender_id: string | null; sender_name: string | null; body: string; reply_to_id: string | null;
  reply_to: { id: string; body: string; sender_name: string } | null; client_id: string | null; edited_at: string | null; deleted_at: string | null;
  pinned_at: string | null; created_at: string; attachments: Att[]; reactions: { emoji: string; count: number; users: string[] }[];
}
interface Participant { user_id: string; role: string; last_read_at: string; last_delivered_at: string; muted: boolean }
interface Pending { client_id: string; body: string; files: File[]; reply?: Msg | null; status: 'sending' | 'failed'; created_at: string }

export const EMOJIS = ['😀', '😂', '😊', '😍', '🤔', '😎', '😢', '😮', '👍', '👎', '👏', '🙏', '🎉', '🔥', '❤️', '✅', '❌', '👀', '💯', '🚀', '☕', '📌', '📎', '🙌'];
const QUICK = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];
const ALLOWED = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/(plain|csv)|application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|vnd\.ms-excel|vnd\.ms-powerpoint|zip))$/;
const MAX_FILE = 25 * 1024 * 1024;
const PAGE = 40;

/** Group photos live in the private chat bucket (image_url holds the storage path); resolve to a short-lived signed URL. */
export function useConversationImage(imageUrl: string | null | undefined) {
  const isPath = !!imageUrl && !/^https?:/.test(imageUrl);
  const q = useQuery({ queryKey: ['chat-group-image', imageUrl], enabled: isPath, staleTime: 50 * 60_000,
    queryFn: () => api.storage.signedUrl('chat-attachments', imageUrl!, 3600) });
  return isPath ? q.data ?? null : imageUrl ?? null;
}

const dayLabel = (d: Date) => (isToday(d) ? 'Today' : isYesterday(d) ? 'Yesterday' : fmtDate(d, 'EEEE, dd MMM yyyy'));

function AttachmentView({ a }: { a: Att }) {
  const isImage = a.mime.startsWith('image/');
  const url = useQuery({ queryKey: ['chat-att', a.path], enabled: isImage, staleTime: 240_000, queryFn: () => api.storage.signedUrl('chat-attachments', a.path, 300) });
  const download = async () => {
    try {
      downloadBlob(a.name, await api.storage.download('chat-attachments', a.path));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  if (isImage) {
    return url.data ? (
      <button type="button" onClick={() => window.open(url.data, '_blank', 'noopener')} className="mt-1 block overflow-hidden rounded-lg border border-slate-200">
        <img src={url.data} alt={a.name} className="max-h-60 max-w-[260px] object-cover" loading="lazy" />
      </button>
    ) : <div className="mt-1 flex h-24 w-40 items-center justify-center rounded-lg bg-slate-100"><Spinner /></div>;
  }
  return (
    <button type="button" onClick={download} className="mt-1 flex max-w-[280px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-xs hover:bg-slate-50">
      <FileText className="h-6 w-6 shrink-0 text-brand-600" />
      <span className="min-w-0 flex-1"><span className="block truncate font-medium text-slate-800">{a.name}</span><span className="text-slate-500">{fileSize(a.size)}</span></span>
      <Download className="h-4 w-4 text-slate-400" />
    </button>
  );
}

export function ChatWindow({ conversation, directory, onBack, onToggleDetails }: {
  conversation: ChatConversation; directory: Map<string, DirectoryEntry>; onBack: () => void; onToggleDetails: () => void;
}) {
  const { user } = useSession();
  const { companyId } = useCompany();
  const { tick, refresh } = useChat();
  const qc = useQueryClient();
  const cid = conversation.id;
  const [limit, setLimit] = useState(PAGE);
  const [pending, setPending] = useState<Pending[]>([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [editing, setEditing] = useState<Msg | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [reactFor, setReactFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Msg | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlight, setHighlight] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastTyping = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const msgs = useQuery({
    queryKey: ['chat-messages', cid, limit],
    queryFn: () => api.db.list<Msg>({ table: 'v_chat_messages', filters: [{ column: 'conversation_id', op: 'eq', value: cid }], order: [{ column: 'created_at', ascending: false }], range: [0, limit - 1] }),
    placeholderData: (prev) => prev,
  });
  const participants = useQuery({
    queryKey: ['chat-participants', cid],
    queryFn: () => api.db.list<Participant>({ table: 'chat_participants', filters: [{ column: 'conversation_id', op: 'eq', value: cid }], range: [0, 999], count: false }),
  });
  const typing = useQuery({
    queryKey: ['chat-typing', cid],
    queryFn: () => api.db.list<{ user_id: string; typing_at: string }>({ table: 'chat_typing_status', filters: [{ column: 'conversation_id', op: 'eq', value: cid }], count: false }),
  });
  const results = useQuery({
    queryKey: ['chat-search', cid, search],
    enabled: searchOpen && search.trim().length >= 2,
    queryFn: () => api.db.list<Msg>({ table: 'v_chat_messages', filters: [{ column: 'conversation_id', op: 'eq', value: cid }, { column: 'deleted_at', op: 'is', value: null }], search: { columns: ['body'], term: search }, order: [{ column: 'created_at', ascending: false }], range: [0, 29] }),
  });

  // realtime tick → refresh this conversation's data
  useEffect(() => {
    if (tick === 0) return;
    void qc.invalidateQueries({ queryKey: ['chat-messages', cid] });
    void qc.invalidateQueries({ queryKey: ['chat-participants', cid] });
    void qc.invalidateQueries({ queryKey: ['chat-typing', cid] });
  }, [tick, cid, qc]);

  // reset state when switching conversations
  useEffect(() => {
    setLimit(PAGE); setPending([]); setText(''); setFiles([]); setReplyTo(null); setEditing(null); setSearchOpen(false); setSearch('');
    atBottom.current = true;
  }, [cid]);

  const rows = useMemo(() => [...(msgs.data?.rows ?? [])].reverse(), [msgs.data]);
  const total = msgs.data?.count ?? 0;
  // drop optimistic messages once the server copy arrives (dedupe by client_id)
  useEffect(() => {
    const ids = new Set(rows.map((r) => r.client_id).filter(Boolean));
    setPending((p) => (p.some((x) => ids.has(x.client_id)) ? p.filter((x) => !ids.has(x.client_id)) : p));
  }, [rows]);

  // mark as read whenever new messages are visible
  const lastId = rows[rows.length - 1]?.id;
  useEffect(() => {
    if (!lastId) return;
    const markRead = () => {
      if (document.visibilityState !== 'visible') return;
      void api.db.rpc('chat_mark_read', { p_conversation: cid }).then(() => refresh()).catch(() => undefined);
    };
    markRead();
    // messages that arrived while the tab was hidden are read when the user comes back to it
    document.addEventListener('visibilitychange', markRead);
    return () => document.removeEventListener('visibilitychange', markRead);
  }, [lastId, cid, refresh]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, pending.length, cid]);

  const others = (participants.data?.rows ?? []).filter((p) => p.user_id !== user?.id);
  const typingRows = (typing.data?.rows ?? []).filter((t) => t.user_id !== user?.id && Date.now() - new Date(t.typing_at).getTime() < 7000);
  // typing rows expire client-side (7 s) without any server event: re-render so the indicator disappears on time
  const [, setNow] = useState(0);
  const typingActive = typingRows.length > 0;
  useEffect(() => {
    if (!typingActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [typingActive]);
  // stop "typing…" for others when leaving the conversation mid-draft
  useEffect(() => () => {
    if (Date.now() - lastTyping.current < 7000) void api.db.rpc('chat_set_typing', { p_conversation: cid, p_typing: false }).catch(() => undefined);
    lastTyping.current = 0;
  }, [cid]);
  const typingNames = typingRows
    .map((t) => directory.get(t.user_id)?.full_name?.split(' ')[0] ?? 'Someone');

  const receipt = (m: Msg) => {
    if (!others.length) return null;
    const readers = others.filter((p) => new Date(p.last_read_at) >= new Date(m.created_at)).length;
    if (conversation.type === 'group') return readers ? `Seen by ${readers}` : 'Sent';
    if (readers) return 'Read';
    return others.some((p) => new Date(p.last_delivered_at) >= new Date(m.created_at)) ? 'Delivered' : 'Sent';
  };

  const onTyping = (v: string) => {
    setText(v);
    if (!editing && v.trim() && Date.now() - lastTyping.current > 3000) {
      lastTyping.current = Date.now();
      void api.db.rpc('chat_set_typing', { p_conversation: cid, p_typing: true }).catch(() => undefined);
    } else if (!v.trim() && lastTyping.current) {
      lastTyping.current = 0; // draft cleared → stop the indicator immediately
      void api.db.rpc('chat_set_typing', { p_conversation: cid, p_typing: false }).catch(() => undefined);
    }
  };

  const sendPending = useCallback(async (p: Pending) => {
    setPending((list) => list.map((x) => (x.client_id === p.client_id ? { ...x, status: 'sending' } : x)));
    try {
      const atts = [];
      for (const f of p.files) {
        const safe = f.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100);
        const path = `${companyId}/${cid}/${crypto.randomUUID()}/${safe}`;
        await api.storage.upload('chat-attachments', path, f, f.type);
        atts.push({ path, name: f.name.slice(0, 200), mime: f.type, size: f.size });
      }
      await api.db.rpc('chat_send_message', { p_conversation: cid, p_body: p.body, p_client_id: p.client_id, p_reply_to: p.reply?.id ?? null, p_attachments: atts });
      lastTyping.current = 0;
      atBottom.current = true;
      await qc.invalidateQueries({ queryKey: ['chat-messages', cid] });
      refresh();
    } catch (e) {
      setPending((list) => list.map((x) => (x.client_id === p.client_id ? { ...x, status: 'failed' } : x)));
      toast.error((e as Error).message || 'Message failed to send');
    }
  }, [cid, companyId, qc, refresh]);

  const submit = async () => {
    const body = text.trim();
    if (editing) {
      if (!body) return;
      try {
        await api.db.rpc('chat_edit_message', { p_message: editing.id, p_body: body });
        setEditing(null);
        setText('');
        await qc.invalidateQueries({ queryKey: ['chat-messages', cid] });
      } catch (e) {
        toast.error((e as Error).message);
      }
      return;
    }
    if (!body && !files.length) return;
    if (body.length > 8000) return toast.error('Message is too long (max 8000 characters)');
    const p: Pending = { client_id: crypto.randomUUID().replace(/-/g, ''), body, files, reply: replyTo, status: 'sending', created_at: new Date().toISOString() };
    setPending((list) => [...list, p]);
    setText(''); setFiles([]); setReplyTo(null); setEmojiOpen(false);
    void sendPending(p);
  };

  const addFiles = (list: FileList | null) => {
    const next = [...files];
    for (const f of Array.from(list ?? [])) {
      if (!ALLOWED.test(f.type)) { toast.error(`${f.name}: file type not allowed`); continue; }
      if (f.size > MAX_FILE) { toast.error(`${f.name}: max 25 MB`); continue; }
      next.push(f);
    }
    setFiles(next.slice(0, 10));
  };

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
      await qc.invalidateQueries({ queryKey: ['chat-messages', cid] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const jumpTo = (id: string) => {
    setSearchOpen(false);
    setHighlight(id);
    atBottom.current = false;
    setTimeout(() => document.getElementById(`msg-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100);
    setTimeout(() => setHighlight(null), 2500);
  };

  const groupImage = useConversationImage(conversation.image_url);
  const other = conversation.other_user_id ? directory.get(conversation.other_user_id) : undefined;
  const online = conversation.type === 'direct' && (other ? isOnline(other.last_seen_at, other.presence_status) : isOnline(conversation.other_last_seen));

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-white">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 px-3 sm:px-4">
        <button type="button" className="btn-ghost p-2 lg:hidden" onClick={onBack} aria-label="Back to conversations"><ArrowLeft className="h-5 w-5" /></button>
        <div className="relative">
          <Avatar name={conversation.name} size="sm" src={groupImage} />
          {conversation.type === 'direct' && <span className={clsx('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white', online ? 'bg-emerald-500' : 'bg-slate-300')} />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-slate-900">{conversation.type === 'group' ? `# ${conversation.name}` : conversation.name}</h2>
          <p className="truncate text-xs text-slate-500">
            {typingNames.length ? <span className="text-brand-600">{typingNames.join(', ')} {typingNames.length > 1 ? 'are' : 'is'} typing…</span>
              : conversation.type === 'group' ? `${conversation.member_count} members` : online ? 'Online' : other?.last_seen_at ? `Last seen ${fmtRelative(other.last_seen_at)}` : other?.role_name ?? ''}
          </p>
        </div>
        <button type="button" className="btn-ghost p-2" aria-label="Search messages" onClick={() => setSearchOpen((s) => !s)}><Search className="h-5 w-5" /></button>
        <button type="button" className="btn-ghost p-2" aria-label="Conversation details" onClick={onToggleDetails}><Info className="h-5 w-5" /></button>
      </header>

      {searchOpen && (
        <div className="border-b border-slate-200 bg-slate-50 p-3">
          <input autoFocus className="input" placeholder="Search in this conversation…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search in conversation" />
          {search.trim().length >= 2 && (
            <ul className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-slate-200 bg-white">
              {results.isLoading && <li className="p-3 text-sm text-slate-500">Searching…</li>}
              {results.data?.rows.length === 0 && <li className="p-3 text-sm text-slate-500">No messages found</li>}
              {results.data?.rows.map((r) => (
                <li key={r.id}><button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => {
                  const idx = (msgs.data?.rows ?? []).findIndex((x) => x.id === r.id);
                  if (idx === -1) setLimit(Math.min(total, 500));
                  jumpTo(r.id);
                }}>
                  <span className="font-medium">{r.sender_name}</span> <span className="text-xs text-slate-400">{fmtDate(r.created_at, 'dd MMM, hh:mm a')}</span>
                  <span className="block truncate text-slate-600">{r.body}</span>
                </button></li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div ref={scroller} data-testid="message-pane" className="flex-1 overflow-y-auto px-3 py-4 sm:px-5" onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }} aria-live="polite">
        {msgs.isLoading ? <div className="flex h-full items-center justify-center"><Spinner /></div> : (
          <>
            {total > rows.length && (
              <div className="mb-4 text-center"><Button size="sm" variant="secondary" loading={msgs.isFetching} onClick={() => { atBottom.current = false; setLimit((l) => l + PAGE); }}>Load older messages</Button></div>
            )}
            {rows.length === 0 && !pending.length && (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <Avatar name={conversation.name} size="lg" />
                <p className="mt-3 font-semibold">{conversation.type === 'group' ? `Welcome to #${conversation.name}` : `This is the beginning of your conversation with ${conversation.name}`}</p>
                <p className="mt-1 text-sm text-slate-500">Say hello 👋</p>
              </div>
            )}
            {rows.map((m, i) => {
              const prev = rows[i - 1];
              const newDay = !prev || !isSameDay(new Date(prev.created_at), new Date(m.created_at));
              const grouped = !newDay && prev?.sender_id === m.sender_id && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60000 && !m.reply_to;
              const mine = m.sender_id === user?.id;
              const isLastMine = mine && !rows.slice(i + 1).some((x) => x.sender_id === user?.id);
              if (!m.sender_id) {
                return (
                  <div key={m.id}>
                    {newDay && <div className="my-4 flex items-center gap-3 text-xs font-medium text-slate-400"><span className="h-px flex-1 bg-slate-200" />{dayLabel(new Date(m.created_at))}<span className="h-px flex-1 bg-slate-200" /></div>}
                    <p className="my-2 text-center text-xs text-slate-400">{m.body} · {fmtTime(m.created_at)}</p>
                  </div>
                );
              }
              return (
                <div key={m.id} id={`msg-${m.id}`}>
                  {newDay && <div className="my-4 flex items-center gap-3 text-xs font-medium text-slate-400"><span className="h-px flex-1 bg-slate-200" />{dayLabel(new Date(m.created_at))}<span className="h-px flex-1 bg-slate-200" /></div>}
                  <div tabIndex={0} data-testid="message-row" className={clsx('group relative flex gap-3 rounded-lg px-2 py-0.5 outline-none transition hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500/30', grouped ? 'mt-0' : 'mt-3', highlight === m.id && 'bg-amber-50 ring-1 ring-amber-200')}>
                    <div className="w-9 shrink-0">{!grouped && <Avatar name={m.sender_name} size="sm" />}</div>
                    <div className="min-w-0 flex-1">
                      {!grouped && (
                        <p className="text-sm"><span className="font-semibold text-slate-900">{mine ? 'You' : m.sender_name}</span> <span className="text-xs text-slate-400">{fmtTime(m.created_at)}</span>
                          {m.pinned_at && <Pin className="ml-1 inline h-3 w-3 text-amber-500" aria-label="Pinned" />}</p>
                      )}
                      {m.reply_to && (
                        <button type="button" onClick={() => jumpTo(m.reply_to!.id)} className="mb-1 mt-0.5 block max-w-md truncate border-l-2 border-brand-300 pl-2 text-left text-xs text-slate-500 hover:text-slate-700">
                          <span className="font-medium">{m.reply_to.sender_name}</span>: {m.reply_to.body}
                        </button>
                      )}
                      {m.deleted_at ? <p className="text-sm italic text-slate-400">This message was deleted</p> : (
                        <>
                          {m.body && <p className="whitespace-pre-wrap break-words text-sm text-slate-800">{m.body}{m.edited_at && <span className="ml-1 text-[11px] text-slate-400">(edited)</span>}</p>}
                          {m.attachments.map((a) => <AttachmentView key={a.id} a={a} />)}
                        </>
                      )}
                      {m.reactions.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {m.reactions.map((r) => (
                            <button key={r.emoji} type="button" onClick={() => act(() => api.db.rpc('chat_toggle_reaction', { p_message: m.id, p_emoji: r.emoji }))}
                              className={clsx('rounded-full border px-2 py-0.5 text-xs', r.users.includes(user?.id ?? '') ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-slate-200 bg-white text-slate-600')}
                              title={r.users.map((u) => directory.get(u)?.full_name ?? 'Someone').join(', ')} aria-label={`${r.emoji} ${r.count}`}>
                              {r.emoji} {r.count}
                            </button>
                          ))}
                        </div>
                      )}
                      {isLastMine && !m.deleted_at && <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-400" data-testid="receipt">
                        {receipt(m) === 'Read' || receipt(m)?.startsWith('Seen') ? <CheckCheck className="h-3.5 w-3.5 text-brand-500" /> : receipt(m) === 'Delivered' ? <CheckCheck className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}{receipt(m)}
                      </p>}
                    </div>
                    {!m.deleted_at && (
                      <div className="absolute -top-3 right-2 hidden items-center gap-0.5 rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm group-hover:flex group-focus-within:flex">
                        <button type="button" className="rounded p-1 hover:bg-slate-100" aria-label="Add reaction" onClick={() => setReactFor(reactFor === m.id ? null : m.id)}><Smile className="h-4 w-4" /></button>
                        <button type="button" className="rounded p-1 hover:bg-slate-100" aria-label="Reply" onClick={() => { setReplyTo(m); inputRef.current?.focus(); }}><Reply className="h-4 w-4" /></button>
                        <button type="button" className="rounded p-1 hover:bg-slate-100" aria-label="Copy message" onClick={() => navigator.clipboard.writeText(m.body).then(() => toast.success('Copied'), () => toast.error('Copy failed'))}><Copy className="h-4 w-4" /></button>
                        <button type="button" className="rounded p-1 hover:bg-slate-100" aria-label={m.pinned_at ? 'Unpin message' : 'Pin message'} onClick={() => act(() => api.db.rpc('chat_toggle_pin', { p_message: m.id }), m.pinned_at ? 'Unpinned' : 'Pinned')}><Pin className="h-4 w-4" /></button>
                        {mine && <button type="button" className="rounded p-1 hover:bg-slate-100" aria-label="Edit message" onClick={() => { setEditing(m); setText(m.body); inputRef.current?.focus(); }}><Pencil className="h-4 w-4" /></button>}
                        {mine && <button type="button" className="rounded p-1 text-rose-600 hover:bg-rose-50" aria-label="Delete message" onClick={() => setDeleting(m)}><Trash2 className="h-4 w-4" /></button>}
                      </div>
                    )}
                    {reactFor === m.id && (
                      <div className="absolute right-2 top-5 z-10 flex gap-1 rounded-full border border-slate-200 bg-white p-1 shadow-pop">
                        {QUICK.map((e) => <button key={e} type="button" className="rounded-full p-1 text-lg hover:bg-slate-100" aria-label={`React ${e}`} onClick={() => { setReactFor(null); void act(() => api.db.rpc('chat_toggle_reaction', { p_message: m.id, p_emoji: e })); }}>{e}</button>)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {pending.map((p) => (
              <div key={p.client_id} className="mt-3 flex gap-3 px-2 opacity-80">
                <div className="w-9 shrink-0"><Avatar name={user?.fullName ?? user?.email} size="sm" /></div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">You</p>
                  {p.body && <p className="whitespace-pre-wrap break-words text-sm text-slate-800">{p.body}</p>}
                  {p.files.map((f) => <p key={f.name} className="text-xs text-slate-500">📎 {f.name}</p>)}
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-400">
                    {p.status === 'sending' ? <><Loader2 className="h-3 w-3 animate-spin" /> Sending…</> : <span className="text-rose-600">Failed · <button type="button" className="underline" onClick={() => void sendPending(p)}>Retry</button> · <button type="button" className="underline" onClick={() => setPending((l) => l.filter((x) => x.client_id !== p.client_id))}>Discard</button></span>}
                  </p>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-200 p-3">
        {(replyTo || editing) && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {replyTo ? <Reply className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
            <span className="min-w-0 flex-1 truncate">{replyTo ? <>Replying to <strong>{replyTo.sender_name}</strong>: {replyTo.body}</> : 'Editing message'}</span>
            <button type="button" aria-label="Cancel" onClick={() => { setReplyTo(null); if (editing) { setEditing(null); setText(''); } }}><X className="h-4 w-4" /></button>
          </div>
        )}
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {files.map((f, i) => (
              <span key={i} className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs">📎 {f.name} <span className="text-slate-400">{fileSize(f.size)}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><X className="h-3 w-3" /></button></span>
            ))}
          </div>
        )}
        <div className="relative flex items-end gap-2 rounded-xl border border-slate-200 bg-white p-1.5 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-500/20">
          <button type="button" className="btn-ghost p-2" aria-label="Attach files" onClick={() => fileRef.current?.click()} disabled={!!editing}><Paperclip className="h-5 w-5" /></button>
          <input ref={fileRef} type="file" multiple className="hidden" data-testid="chat-file-input" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <textarea ref={inputRef} rows={1} value={text} onChange={(e) => onTyping(e.target.value)} placeholder={`Message ${conversation.type === 'group' ? '#' + conversation.name : conversation.name}`}
            aria-label="Message" className="max-h-40 min-h-[40px] flex-1 resize-none border-0 bg-transparent px-1 py-2 text-sm focus:outline-none focus:ring-0"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
              if (e.key === 'Escape') { setReplyTo(null); setEditing(null); }
            }}
            onInput={(e) => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; }} />
          <button type="button" className="btn-ghost p-2" aria-label="Insert emoji" aria-expanded={emojiOpen} onClick={() => setEmojiOpen((o) => !o)}><Smile className="h-5 w-5" /></button>
          <Button aria-label={editing ? 'Save edit' : 'Send message'} className="h-10 px-3" onClick={() => void submit()} disabled={!text.trim() && !files.length}><Send className="h-4 w-4" /></Button>
          {emojiOpen && (
            <div className="absolute bottom-14 right-2 z-20 grid w-72 grid-cols-8 gap-1 rounded-xl border border-slate-200 bg-white p-2 shadow-pop" role="dialog" aria-label="Emoji picker">
              {EMOJIS.map((e) => <button key={e} type="button" className="rounded p-1 text-xl hover:bg-slate-100" onClick={() => { setText((t) => t + e); inputRef.current?.focus(); }} aria-label={`Insert ${e}`}>{e}</button>)}
            </div>
          )}
        </div>
        <p className="mt-1 hidden text-[11px] text-slate-400 sm:block">Enter to send · Shift+Enter for a new line · up to 10 files, 25 MB each</p>
      </div>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete message?" tone="danger" confirmLabel="Delete"
        message="This message and its attachments will be removed for everyone." onConfirm={() => { const m = deleting!; setDeleting(null); void act(() => api.db.rpc('chat_delete_message', { p_message: m.id }), 'Message deleted'); }} />
    </div>
  );
}
