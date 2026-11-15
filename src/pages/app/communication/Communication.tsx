import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bell, BellOff, Camera, Download, FileText, Hash, Megaphone, MessageSquarePlus, MessagesSquare, Paperclip, Pin, Search, Settings2, UserMinus, UserPlus, Users, Volume2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Avatar, Badge, Button, DescriptionList, Drawer, EmptyState, Field, Input, Modal, PageLoader, Spinner, Textarea, Toggle } from '@/components/ui';
import { isOnline, useChat, type ChatConversation } from '@/contexts/chat';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { audioReady, browserNotificationsSupported, playChime, requestBrowserPermission } from '@/lib/chatNotify';
import { downloadBlob } from '@/lib/csv';
import { fileSize, fmtDate, fmtRelative } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { Announcements } from './Announcements';
import { ChatWindow, useConversationImage, type DirectoryEntry, type Msg } from './ChatWindow';

type View = 'all' | 'direct' | 'groups' | 'unread' | 'files' | 'announcements';
const VIEWS: { value: View; label: string; icon: React.ReactNode }[] = [
  { value: 'all', label: 'All messages', icon: <MessagesSquare className="h-4 w-4" /> },
  { value: 'direct', label: 'Direct messages', icon: <MessageSquarePlus className="h-4 w-4" /> },
  { value: 'groups', label: 'Group chats', icon: <Hash className="h-4 w-4" /> },
  { value: 'unread', label: 'Unread', icon: <Bell className="h-4 w-4" /> },
  { value: 'files', label: 'Files & media', icon: <Paperclip className="h-4 w-4" /> },
  { value: 'announcements', label: 'Announcements', icon: <Megaphone className="h-4 w-4" /> },
];

function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

function useDirectory() {
  const { companyId } = useCompany();
  const q = useQuery({
    queryKey: ['chat-directory', companyId],
    enabled: !!companyId,
    queryFn: () => api.db.list<DirectoryEntry>({ table: 'v_chat_directory', filters: [{ column: 'company_id', op: 'eq', value: companyId }], order: [{ column: 'full_name' }], range: [0, 4999], count: false }),
    refetchInterval: 30_000, // presence is heartbeat-based (30 s)
  });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const map = useMemo(() => new Map(rows.map((r) => [r.user_id, r])), [rows]);
  return { rows, map, loading: q.isLoading };
}

function PeoplePicker({ people, selected, onToggle, single }: { people: DirectoryEntry[]; selected: string[]; onToggle: (id: string) => void; single?: boolean }) {
  const [q, setQ] = useState('');
  const term = q.toLowerCase();
  const list = people.filter((p) => !term || `${p.full_name} ${p.email} ${p.employee_code ?? ''} ${p.department_name ?? ''}`.toLowerCase().includes(term));
  return (
    <div>
      <Input placeholder="Search by name, employee ID or department" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
      <ul className="mt-2 max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
        {list.length === 0 && <li className="p-4 text-center text-sm text-slate-500">No people found</li>}
        {list.map((p) => (
          <li key={p.user_id}>
            <button type="button" onClick={() => onToggle(p.user_id)} className={clsx('flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50', selected.includes(p.user_id) && 'bg-brand-50')}>
              <span className="relative"><Avatar name={p.full_name} size="sm" /><span className={clsx('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white', isOnline(p.last_seen_at, p.presence_status) ? 'bg-emerald-500' : 'bg-slate-300')} /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{p.full_name}</span>
                <span className="block truncate text-xs text-slate-500">{[p.designation_title ?? p.role_name, p.department_name, p.employee_code].filter(Boolean).join(' · ')}</span></span>
              {!single && selected.includes(p.user_id) && <Badge tone="blue">Added</Badge>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewChatModal({ open, onClose, directory, onCreated, initialMode }: { open: boolean; onClose: () => void; directory: DirectoryEntry[]; onCreated: (id: string) => void; initialMode: 'direct' | 'group' }) {
  const { companyId } = useCompany();
  const [mode, setMode] = useState(initialMode);
  const [members, setMembers] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setMode(initialMode); setMembers([]); setName(''); setDesc(''); } }, [open, initialMode]);
  const startDm = async (userId: string) => {
    setBusy(true);
    try { onCreated(await api.db.rpc<string>('chat_start_direct', { p_company: companyId, p_user: userId })); onClose(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const createGroup = async () => {
    if (name.trim().length < 2) return toast.error('Group name must be at least 2 characters');
    setBusy(true);
    try { onCreated(await api.db.rpc<string>('chat_create_group', { p_company: companyId, p_name: name, p_description: desc, p_members: members })); toast.success('Group created'); onClose(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={mode === 'direct' ? 'New direct message' : 'Create group'} size="md"
      footer={mode === 'group' ? <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={createGroup}>Create group ({members.length + 1})</Button></> : undefined}>
      <div className="mb-4 flex gap-2">
        <Button size="sm" variant={mode === 'direct' ? 'primary' : 'secondary'} onClick={() => setMode('direct')}>Direct message</Button>
        <Button size="sm" variant={mode === 'group' ? 'primary' : 'secondary'} onClick={() => setMode('group')}>Group chat</Button>
      </div>
      {mode === 'group' && (
        <div className="mb-4 space-y-3">
          <Field label="Group name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Engineering, Payroll team" /></Field>
          <Field label="Description"><Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} /></Field>
          <p className="label !mb-0">Members</p>
        </div>
      )}
      {busy && mode === 'direct' ? <PageLoader /> : (
        <PeoplePicker people={directory} single={mode === 'direct'} selected={members}
          onToggle={(id) => (mode === 'direct' ? void startDm(id) : setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id])))} />
      )}
    </Modal>
  );
}

function SettingsModal({ open, onClose, conversation }: { open: boolean; onClose: () => void; conversation: ChatConversation | null }) {
  const { prefs, savePrefs, refresh } = useChat();
  const [perm, setPerm] = useState(browserNotificationsSupported() ? Notification.permission : 'denied');
  const toggleBrowser = async (v: boolean) => {
    if (v) {
      const p = await requestBrowserPermission();
      setPerm(p);
      if (p !== 'granted') return toast.error('Notifications are blocked in your browser settings');
    }
    await savePrefs({ browser_enabled: v });
  };
  return (
    <Modal open={open} onClose={onClose} title="Notification settings" size="sm" footer={<Button onClick={onClose}>Done</Button>}>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div><p className="text-sm font-medium">Message sound</p><p className="text-xs text-slate-500">Play a chime for new messages (not for your own or muted chats).</p></div>
          <Toggle label="Message sound" checked={prefs.sound_enabled} onChange={(v) => void savePrefs({ sound_enabled: v })} />
        </div>
        <Button size="sm" variant="secondary" icon={<Volume2 className="h-4 w-4" />} onClick={() => { if (!playChime()) toast.info('Click anywhere on the page once to enable audio, then try again'); }}>Test sound</Button>
        <div className="flex items-center justify-between gap-4">
          <div><p className="text-sm font-medium">Browser notifications</p><p className="text-xs text-slate-500">{perm === 'denied' ? 'Blocked by the browser or unsupported.' : 'Show a desktop notification when the HRMS tab is in the background.'}</p></div>
          <Toggle label="Browser notifications" checked={prefs.browser_enabled && perm === 'granted'} onChange={(v) => void toggleBrowser(v)} disabled={perm === 'denied'} />
        </div>
        {conversation && (
          <div className="flex items-center justify-between gap-4 border-t border-slate-100 pt-4">
            <div><p className="text-sm font-medium">Mute “{conversation.name}”</p><p className="text-xs text-slate-500">No sound or notifications for this conversation.</p></div>
            <Toggle label="Mute conversation" checked={conversation.muted} onChange={async (v) => { await api.db.rpc('chat_set_muted', { p_conversation: conversation.id, p_muted: v }); refresh(); }} />
          </div>
        )}
        {!audioReady() && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Audio starts after your first click or key press (browser autoplay rules).</p>}
      </div>
    </Modal>
  );
}

function Details({ conversation, directory, onClose }: { conversation: ChatConversation; directory: Map<string, DirectoryEntry>; onClose: () => void }) {
  const { user } = useSession();
  const { tick, refresh, setActiveId } = useChat();
  const [adding, setAdding] = useState(false);
  const [toAdd, setToAdd] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(conversation.name);
  const [desc, setDesc] = useState(conversation.description ?? '');
  const parts = useQuery({ queryKey: ['chat-participants-detail', conversation.id, tick], queryFn: () => api.db.list<{ user_id: string; role: string }>({ table: 'chat_participants', filters: [{ column: 'conversation_id', op: 'eq', value: conversation.id }], range: [0, 999], count: false }) });
  const pinned = useQuery({ queryKey: ['chat-pinned', conversation.id, tick], queryFn: () => api.db.list<Msg>({ table: 'v_chat_messages', filters: [{ column: 'conversation_id', op: 'eq', value: conversation.id }, { column: 'pinned_at', op: 'is', value: 'not_null' }], order: [{ column: 'pinned_at', ascending: false }], range: [0, 19] }) });
  const files = useQuery({ queryKey: ['chat-files', conversation.id, tick], queryFn: () => api.db.list<{ id: string; storage_path: string; file_name: string; size_bytes: number; created_at: string }>({ table: 'chat_attachments', filters: [{ column: 'conversation_id', op: 'eq', value: conversation.id }], order: [{ column: 'created_at', ascending: false }], range: [0, 29] }) });
  const isAdmin = conversation.my_role === 'admin';
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast.success(ok); refresh(); void parts.refetch(); } catch (e) { toast.error((e as Error).message); } };
  const other = conversation.other_user_id ? directory.get(conversation.other_user_id) : undefined;
  const { companyId } = useCompany();
  const groupImage = useConversationImage(conversation.image_url);
  const [uploading, setUploading] = useState(false);
  const setPhoto = async (f: File | undefined) => {
    if (!f) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return toast.error('Use a PNG, JPG, GIF or WebP image');
    if (f.size > 5 * 1024 * 1024) return toast.error('Group photo must be 5 MB or smaller');
    setUploading(true);
    try {
      const path = `${companyId}/${conversation.id}/${crypto.randomUUID()}/group-photo.${f.type.split('/')[1]}`;
      await api.storage.upload('chat-attachments', path, f, f.type);
      await run(() => api.db.rpc('chat_update_group', { p_conversation: conversation.id, p_name: conversation.name, p_description: conversation.description ?? '', p_image_url: path }), 'Group photo updated');
    } catch (e) { toast.error((e as Error).message); } finally { setUploading(false); }
  };
  const memberIds = (parts.data?.rows ?? []).map((p) => p.user_id);
  return (
    <div className="space-y-6">
      {conversation.type === 'direct' && other ? (
        <div className="text-center">
          <Avatar name={other.full_name} size="lg" />
          <p className="mt-2 font-semibold">{other.full_name}</p>
          <p className="text-sm text-slate-500">{other.designation_title ?? other.role_name}</p>
          <Badge tone={isOnline(other.last_seen_at, other.presence_status) ? 'green' : 'gray'} dot className="mt-2">{isOnline(other.last_seen_at, other.presence_status) ? 'Online' : other.last_seen_at ? `Seen ${fmtRelative(other.last_seen_at)}` : 'Offline'}</Badge>
          <div className="mt-4 text-left"><DescriptionList cols={1} items={[{ label: 'Email', value: other.email }, { label: 'Department', value: other.department_name }, { label: 'Employee ID', value: other.employee_code }, { label: 'Role', value: other.role_name }]} /></div>
        </div>
      ) : (
        <div>
          {editing ? (
            <div className="space-y-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Group name" />
              <Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="Group description" />
              <div className="flex gap-2"><Button size="sm" onClick={() => run(() => api.db.rpc('chat_update_group', { p_conversation: conversation.id, p_name: name, p_description: desc, p_image_url: conversation.image_url }), 'Group updated').then(() => setEditing(false))}>Save</Button><Button size="sm" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button></div>
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-3">
                {groupImage ? <img src={groupImage} alt="" className="h-14 w-14 rounded-xl object-cover" /> : <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-violet-100 text-violet-700"><Hash className="h-6 w-6" /></span>}
                {isAdmin && (
                  <label className="btn-secondary cursor-pointer px-3 py-1.5 text-xs">
                    {uploading ? <Spinner className="h-4 w-4" /> : <Camera className="h-4 w-4" />} {groupImage ? 'Change photo' : 'Add photo'}
                    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" aria-label="Group photo" disabled={uploading}
                      onChange={(e) => { void setPhoto(e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                )}
              </div>
              <p className="flex items-center gap-2 font-semibold"><Hash className="h-4 w-4" />{conversation.name}</p>
              <p className="mt-1 text-sm text-slate-500">{conversation.description || 'No description'}</p>
              {isAdmin && <button type="button" className="mt-1 text-xs font-medium text-brand-700 hover:underline" onClick={() => setEditing(true)}>Edit group</button>}
            </>
          )}
          <div className="mt-5 flex items-center justify-between"><p className="text-xs font-semibold uppercase text-slate-500">Members ({memberIds.length})</p>
            {isAdmin && <Button size="sm" variant="ghost" icon={<UserPlus className="h-4 w-4" />} onClick={() => { setToAdd([]); setAdding(true); }}>Add</Button>}</div>
          <ul className="mt-2 space-y-1">
            {(parts.data?.rows ?? []).map((p) => {
              const d = directory.get(p.user_id);
              return (
                <li key={p.user_id} className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm">
                  <span className="relative"><Avatar name={d?.full_name} size="xs" /><span className={clsx('absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-white', isOnline(d?.last_seen_at, d?.presence_status) ? 'bg-emerald-500' : 'bg-slate-300')} /></span>
                  <span className="min-w-0 flex-1 truncate">{d?.full_name ?? 'Former member'}{p.user_id === user?.id && ' (you)'}</span>
                  {p.role === 'admin' && <Badge tone="violet">Admin</Badge>}
                  {isAdmin && p.user_id !== user?.id && (
                    <>
                      <button type="button" className="text-[11px] text-slate-500 hover:text-brand-700" onClick={() => run(() => api.db.rpc('chat_set_member_role', { p_conversation: conversation.id, p_user: p.user_id, p_role: p.role === 'admin' ? 'member' : 'admin' }), 'Role updated')}>{p.role === 'admin' ? 'Revoke admin' : 'Make admin'}</button>
                      <button type="button" aria-label={`Remove ${d?.full_name}`} className="text-slate-400 hover:text-rose-600" onClick={() => run(() => api.db.rpc('chat_remove_member', { p_conversation: conversation.id, p_user: p.user_id }), 'Member removed')}><UserMinus className="h-4 w-4" /></button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <Button size="sm" variant="ghost" className="mt-3 text-rose-600" onClick={() => run(() => api.db.rpc('chat_remove_member', { p_conversation: conversation.id, p_user: user!.id }), 'You left the group').then(() => { setActiveId(null); onClose(); })}>Leave group</Button>
        </div>
      )}
      <div>
        <p className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase text-slate-500"><Pin className="h-3.5 w-3.5" /> Pinned messages</p>
        {(pinned.data?.rows ?? []).length === 0 ? <p className="text-sm text-slate-400">Nothing pinned yet</p> : (
          <ul className="space-y-2">{pinned.data!.rows.map((m) => <li key={m.id} className="rounded-lg bg-amber-50 p-2 text-xs"><span className="font-medium">{m.sender_name}</span>: {m.body || '📎 attachment'}<span className="block text-slate-400">{fmtDate(m.created_at, 'dd MMM, hh:mm a')}</span></li>)}</ul>
        )}
      </div>
      <div>
        <p className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase text-slate-500"><Paperclip className="h-3.5 w-3.5" /> Shared files</p>
        {(files.data?.rows ?? []).length === 0 ? <p className="text-sm text-slate-400">No files shared</p> : (
          <ul className="space-y-1">{files.data!.rows.map((f) => (
            <li key={f.id}><button type="button" className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-slate-50" onClick={async () => { try { downloadBlob(f.file_name, await api.storage.download('chat-attachments', f.storage_path)); } catch (e) { toast.error((e as Error).message); } }}>
              <FileText className="h-4 w-4 shrink-0 text-brand-600" /><span className="min-w-0 flex-1 truncate">{f.file_name}</span><span className="text-slate-400">{fileSize(f.size_bytes)}</span></button></li>
          ))}</ul>
        )}
      </div>
      <Modal open={adding} onClose={() => setAdding(false)} title="Add members" size="md"
        footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button disabled={!toAdd.length} onClick={() => run(() => api.db.rpc('chat_add_members', { p_conversation: conversation.id, p_members: toAdd }), 'Members added').then(() => setAdding(false))}>Add {toAdd.length || ''}</Button></>}>
        <PeoplePicker people={[...directory.values()].filter((d) => !memberIds.includes(d.user_id))} selected={toAdd} onToggle={(id) => setToAdd((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))} />
      </Modal>
    </div>
  );
}

function GroupIcon({ imageUrl }: { imageUrl: string | null }) {
  const src = useConversationImage(imageUrl);
  return src ? <img src={src} alt="" className="h-9 w-9 rounded-lg object-cover" />
    : <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-100 text-violet-700"><Hash className="h-4 w-4" /></span>;
}

function FilesView() {
  const { companyId } = useCompany();
  const { tick } = useChat();
  const [q, setQ] = useState('');
  const term = useDebounced(q);
  const files = useQuery({
    queryKey: ['chat-all-files', companyId, term, tick],
    queryFn: () => api.db.list<{ id: string; storage_path: string; file_name: string; mime_type: string; size_bytes: number; created_at: string; sender_name: string; conversation_name: string; conversation_id: string }>({
      table: 'v_chat_attachments', filters: [{ column: 'company_id', op: 'eq', value: companyId }], search: term ? { columns: ['file_name', 'sender_name'], term } : undefined,
      order: [{ column: 'created_at', ascending: false }], range: [0, 99] }),
  });
  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-slate-200 p-4"><h2 className="font-semibold">Files & media</h2><Input className="mt-3" placeholder="Search files" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search files" /></div>
      <div className="flex-1 overflow-y-auto">
        {files.isLoading ? <PageLoader /> : (files.data?.rows ?? []).length === 0 ? <EmptyState icon={<Paperclip className="h-6 w-6" />} title="No files shared yet" description="Files shared in your conversations appear here." /> : (
          <ul className="divide-y divide-slate-100">{files.data!.rows.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-4 py-3">
              <FileText className="h-8 w-8 shrink-0 rounded-lg bg-brand-50 p-1.5 text-brand-600" />
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{f.file_name}</p><p className="truncate text-xs text-slate-500">{f.sender_name} · {f.conversation_name} · {fileSize(f.size_bytes)} · {fmtRelative(f.created_at)}</p></div>
              <Button size="sm" variant="ghost" aria-label={`Download ${f.file_name}`} onClick={async () => { try { downloadBlob(f.file_name, await api.storage.download('chat-attachments', f.storage_path)); } catch (e) { toast.error((e as Error).message); } }}><Download className="h-4 w-4" /></Button>
            </li>
          ))}</ul>
        )}
      </div>
    </div>
  );
}

export function Communication() {
  const { user } = useSession();
  const { conversations, loading, activeId, setActiveId, unreadTotal } = useChat();
  const [params, setParams] = useSearchParams();
  const directory = useDirectory();
  const view = (params.get('view') as View) || 'all';
  const [search, setSearch] = useState('');
  const [newChat, setNewChat] = useState<'direct' | 'group' | null>(null);
  const [settings, setSettings] = useState(false);
  const [details, setDetails] = useState(false);
  const wide = useMediaQuery('(min-width: 1280px)');

  // conversation from URL (?c=) — used by browser notification clicks
  const urlConv = params.get('c');
  useEffect(() => {
    setActiveId(urlConv);
    return () => setActiveId(null);
  }, [urlConv, setActiveId]);
  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('c', id); else next.delete('c');
    if (id && ['files', 'announcements'].includes(view)) next.delete('view');
    setParams(next, { replace: false });
  };
  const setView = (v: View) => { const next = new URLSearchParams(); if (v !== 'all') next.set('view', v); setParams(next); };

  const filtered = conversations.filter((c) =>
    (view === 'direct' ? c.type === 'direct' : view === 'groups' ? c.type === 'group' : view === 'unread' ? Number(c.unread_count) > 0 : true) &&
    (!search || c.name.toLowerCase().includes(search.toLowerCase())));
  const active = conversations.find((c) => c.id === activeId) ?? null;
  const me = user ? directory.map.get(user.id) : undefined;
  const showConversationPane = view === 'files' || view === 'announcements' || !!active;

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100vh-4rem)] overflow-hidden supports-[height:100dvh]:h-[calc(100dvh-4rem)] border-slate-200 bg-slate-50 sm:-mx-6 lg:-mx-8">
      {/* left panel */}
      <aside className={clsx('w-full shrink-0 flex-col border-r border-slate-200 bg-white lg:flex lg:w-80', showConversationPane ? 'hidden' : 'flex')} aria-label="Conversations">
        <div className="flex items-center gap-3 border-b border-slate-200 p-4">
          <span className="relative"><Avatar name={me?.full_name ?? user?.email} size="sm" /><span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" /></span>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{me?.full_name ?? user?.email}</p><p className="text-xs text-emerald-600">Online</p></div>
          <button type="button" className="btn-ghost p-2" aria-label="Notification settings" onClick={() => setSettings(true)}><Settings2 className="h-5 w-5" /></button>
          <button type="button" className="btn-ghost p-2" aria-label="New message" onClick={() => setNewChat('direct')}><MessageSquarePlus className="h-5 w-5" /></button>
        </div>
        <nav className="scrollbar-thin flex gap-1 overflow-x-auto border-b border-slate-100 px-2 py-2 lg:flex-col lg:overflow-visible" aria-label="Communication views">
          {VIEWS.map((v) => (
            <button key={v.value} type="button" onClick={() => setView(v.value)} aria-current={view === v.value ? 'page' : undefined}
              className={clsx('flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition', view === v.value ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50')}>
              {v.icon}{v.label}{v.value === 'unread' && unreadTotal > 0 && <span className="ml-auto rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">{unreadTotal}</span>}
            </button>
          ))}
        </nav>
        {!['files', 'announcements'].includes(view) && (
          <>
            <div className="flex gap-2 p-3">
              <div className="relative flex-1"><Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input className="input py-1.5 pl-8" placeholder="Search conversations" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search conversations" /></div>
              <Button size="sm" variant="secondary" aria-label="New group" title="New group" onClick={() => setNewChat('group')}><Users className="h-4 w-4" /></Button>
            </div>
            <ul className="flex-1 overflow-y-auto px-2 pb-3" data-testid="conversation-list">
              {loading && <li className="p-6 text-center"><Spinner /></li>}
              {!loading && filtered.length === 0 && (
                <li><EmptyState icon={<MessagesSquare className="h-6 w-6" />} title={view === 'unread' ? 'No unread messages' : 'No conversations yet'} description="Start a direct message or create a group."
                  action={<Button size="sm" onClick={() => setNewChat('direct')}>New message</Button>} /></li>
              )}
              {filtered.map((c) => {
                const unread = Number(c.unread_count);
                return (
                  <li key={c.id}>
                    <button type="button" onClick={() => open(c.id)} aria-current={activeId === c.id ? 'true' : undefined}
                      className={clsx('flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition', activeId === c.id ? 'bg-brand-50' : 'hover:bg-slate-50')}>
                      <span className="relative">
                        {c.type === 'group' ? <GroupIcon imageUrl={c.image_url} /> : <Avatar name={c.name} size="md" />}
                        {c.type === 'direct' && <span className={clsx('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white', (() => { const d = directory.map.get(c.other_user_id ?? ''); return d ? isOnline(d.last_seen_at, d.presence_status) : isOnline(c.other_last_seen); })() ? 'bg-emerald-500' : 'bg-slate-300')} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className={clsx('truncate text-sm', unread ? 'font-semibold text-slate-900' : 'font-medium text-slate-700')}>{c.name}</span>
                          <span className="shrink-0 text-[11px] text-slate-400">{c.last_message_id ? fmtRelative(c.last_message_at).replace('about ', '').replace('less than a minute ago', 'now') : ''}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <span className={clsx('truncate text-xs', unread ? 'text-slate-700' : 'text-slate-500')}>
                            {c.last_message_body ? `${c.last_message_sender === user?.id ? 'You: ' : c.type === 'group' && c.last_message_sender_name ? `${c.last_message_sender_name.split(' ')[0]}: ` : ''}${c.last_message_body}` : c.last_message_has_attachments ? '📎 Attachment' : 'No messages yet'}
                          </span>
                          {c.muted && <BellOff className="h-3 w-3 shrink-0 text-slate-400" aria-label="Muted" />}
                          {unread > 0 && <span className="ml-auto shrink-0 rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold text-white" data-testid="unread-badge">{unread}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </aside>

      {/* center */}
      <section className={clsx('min-w-0 flex-1 flex-col', showConversationPane ? 'flex' : 'hidden lg:flex')}>
        {view === 'announcements' ? <Announcements onBack={() => setView('all')} />
          : view === 'files' ? <FilesView />
            : active ? <ChatWindow conversation={active} directory={directory.map} onBack={() => open(null)} onToggleDetails={() => setDetails((d) => !d)} />
              : (
                <div className="flex h-full flex-col items-center justify-center bg-white p-8 text-center">
                  <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-600"><MessagesSquare className="h-8 w-8" /></span>
                  <h2 className="mt-4 text-lg font-semibold">Team communication</h2>
                  <p className="mt-1 max-w-sm text-sm text-slate-500">Message colleagues one-to-one, collaborate in groups and read company announcements — all inside your HRMS.</p>
                  <div className="mt-5 flex gap-2"><Button onClick={() => setNewChat('direct')}>New message</Button><Button variant="secondary" onClick={() => setNewChat('group')}>Create group</Button></div>
                </div>
              )}
      </section>

      {/* right details panel */}
      {active && details && !['files', 'announcements'].includes(view) && (wide ? (
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-slate-200 bg-white p-5" aria-label="Conversation details">
          <div className="mb-4 flex items-center justify-between"><h3 className="font-semibold">Details</h3><button type="button" aria-label="Close details" className="btn-ghost p-1" onClick={() => setDetails(false)}><X className="h-4 w-4" /></button></div>
          <Details conversation={active} directory={directory.map} onClose={() => setDetails(false)} />
        </aside>
      ) : (
        <Drawer open onClose={() => setDetails(false)} title="Details" width="max-w-sm"><Details conversation={active} directory={directory.map} onClose={() => setDetails(false)} /></Drawer>
      ))}

      <NewChatModal open={!!newChat} initialMode={newChat ?? 'direct'} onClose={() => setNewChat(null)} directory={directory.rows.filter((d) => d.user_id !== user?.id)} onCreated={(id) => open(id)} />
      <SettingsModal open={settings} onClose={() => setSettings(false)} conversation={active} />
    </div>
  );
}
