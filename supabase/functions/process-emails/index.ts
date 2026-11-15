// Supabase Edge Function: delivers queued emails from public.email_logs.
// Secrets (set with `supabase secrets set ...`, never in the frontend):
//   EMAIL_MODE            "mock" (default: mark as sent without delivering) | "resend"
//   RESEND_API_KEY        required when EMAIL_MODE=resend
//   EMAIL_FROM            e.g. "HRMS <no-reply@your-verified-domain.com>"
//   EMAIL_TEST_RECIPIENT  optional: redirect ALL emails to this address (UAT / testing)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by Supabase.
// Invoked by the app after workflow actions (JWT-verified) and/or by a cron schedule.
import { createClient } from 'jsr:@supabase/supabase-js@2';

interface EmailRow {
  id: string;
  to_email: string;
  to_name: string | null;
  subject: string;
  body_html: string;
  attachments: { bucket: string; path: string; filename: string }[];
  company_id: string;
}

const MODE = (Deno.env.get('EMAIL_MODE') ?? 'mock').toLowerCase();
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = Deno.env.get('EMAIL_FROM') ?? 'HRMS <onboarding@resend.dev>';
const TEST_RECIPIENT = Deno.env.get('EMAIL_TEST_RECIPIENT') ?? '';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  // queue interview reminders due in the next 24 h first (no-op if migration 1400 is not applied yet)
  const { data: reminders } = await admin.rpc('send_interview_reminders');
  const { data: batch, error } = await admin.rpc('claim_email_batch', { p_limit: 25 });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });

  const result = { processed: 0, sent: 0, failed: 0, mode: MODE, reminders: Number(reminders ?? 0) };
  for (const e of (batch ?? []) as EmailRow[]) {
    result.processed++;
    try {
      if (MODE !== 'resend') {
        await admin.rpc('complete_email', { p_id: e.id, p_success: true, p_provider: 'mock', p_message_id: `mock-${e.id.slice(0, 8)}`, p_error: null });
        result.sent++;
        continue;
      }
      if (!RESEND_KEY) throw new Error('RESEND_API_KEY is not configured');
      const attachments = [];
      for (const a of e.attachments ?? []) {
        const { data, error: dlErr } = await admin.storage.from(a.bucket).download(a.path);
        if (dlErr || !data) throw new Error(`Attachment missing: ${a.path}`);
        attachments.push({ filename: a.filename, content: toBase64(await data.arrayBuffer()) });
      }
      const to = TEST_RECIPIENT || e.to_email;
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM,
          to: [to],
          subject: TEST_RECIPIENT ? `[TEST → ${e.to_email}] ${e.subject}` : e.subject,
          html: e.body_html,
          attachments,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message ?? `Resend HTTP ${res.status}`);
      await admin.rpc('complete_email', { p_id: e.id, p_success: true, p_provider: 'resend', p_message_id: body.id ?? null, p_error: null });
      result.sent++;
    } catch (err) {
      result.failed++;
      await admin.rpc('complete_email', { p_id: e.id, p_success: false, p_provider: MODE, p_message_id: null, p_error: String((err as Error).message ?? err) });
    }
  }
  return new Response(JSON.stringify(result), { headers: { ...cors, 'Content-Type': 'application/json' } });
});
