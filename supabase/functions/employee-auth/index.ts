// Supabase Edge Function: employee account actions that need the service role.
//   POST { action: 'activate', token, password }   one-time "set your password" link from the Employee ID email
//   POST { action: 'login', employee_id, password } sign in with an Employee ID instead of an email
// All rules (token validity, expiry, email binding, which employee) live in SQL (migration 1900) and are unit-tested there;
// this function only performs the auth-admin calls the database cannot make. Emails behind an Employee ID never leave the server.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (message: string, status = 400) => json({ error: message }, status);

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;

function validPassword(pw: unknown): pw is string {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 72 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Method not allowed', 405);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail('Invalid request');
  }
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

  if (body.action === 'activate') {
    const token = String(body.token ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(token)) return fail('This link is not valid');
    if (!validPassword(body.password)) return fail('Password must be at least 8 characters and contain letters and numbers');
    const { data: info, error: e1 } = await admin.rpc('public_employee_activation', { p_token: token });
    if (e1) return fail(e1.message, 500);
    const status = (info as { status: string }).status;
    if (status === 'invalid' || status === 'used') return fail('This link is not valid or was already used');
    if (status === 'expired') return fail('This link has expired. Ask HR to send a new one.');
    const email = String((info as { email: string }).email).toLowerCase();
    const fullName = String((info as { employee_name: string }).employee_name ?? '');

    // the link arrived in this mailbox, so it may set the password of an existing account with the same email too
    let userId: string | null = null;
    const { data: created, error: e2 } = await admin.auth.admin.createUser({ email, password: body.password, email_confirm: true, user_metadata: { full_name: fullName } });
    if (created?.user) userId = created.user.id;
    else if (e2 && /already|exists|registered/i.test(e2.message)) {
      const { data: existing } = await admin.from('profiles').select('id').ilike('email', email).maybeSingle();
      if (!existing) return fail('Could not find the existing account for this email', 500);
      const { error: e3 } = await admin.auth.admin.updateUserById(existing.id, { password: body.password, email_confirm: true });
      if (e3) return fail(e3.message, 500);
      userId = existing.id;
    } else return fail(e2?.message ?? 'Could not create the account', 500);

    const { error: e4 } = await admin.rpc('consume_employee_activation', { p_token: token, p_user: userId });
    if (e4) return fail(e4.message);
    return json({ ok: true, email });
  }

  if (body.action === 'login') {
    const code = String(body.employee_id ?? '').trim();
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(code) || typeof body.password !== 'string') return fail('Invalid Employee ID or password', 401);
    const { data: emails, error } = await admin.rpc('login_emails_for_code', { p_code: code });
    if (error) return fail(error.message, 500);
    // the same Employee ID can exist in several companies: try each linked account, return the one the password opens
    for (const email of (emails ?? []) as string[]) {
      const anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data } = await anon.auth.signInWithPassword({ email, password: body.password });
      if (data.session) return json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
    }
    return fail('Invalid Employee ID or password', 401);
  }

  return fail('Unknown action');
});
