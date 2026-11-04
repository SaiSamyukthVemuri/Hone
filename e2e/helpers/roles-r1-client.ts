import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "./local-env";
import { sql } from "./seed";

// Real signed-in sessions for the Roles R1 engine (#1340, held 0287). Plan-stage: typechecked only, never run.
// A user JWT comes from a real GoTrue password grant on the isolated stack (synthetic users only), and every call goes through
// PostgREST /rest/v1/rpc as that user: the same path the app's own client uses, so the database resolver (not a mock) decides.
// The anon key is the local stack's published key. local-env.ts keeps it private (and must not be edited), so the runner exports it
// as E2E_SUPABASE_ANON_KEY (from `supabase status` of the OWNED stack). Read lazily so importing this file never needs it.
function anon(): string {
  const k = process.env.E2E_SUPABASE_ANON_KEY;
  if (!k) throw new Error("E2E_SUPABASE_ANON_KEY is not set: the runner must export the owned stack's anon key");
  return k;
}

export async function jwtFor(email: string): Promise<{ token: string; userId: string }> {
  const password = `Pw-${Math.random().toString(36).slice(2)}-Aa1!`;
  const row = (await sql<{ id: string }>(`select id from auth.users where email = $1`, [email]))[0];
  if (!row) throw new Error("jwtFor: no such synthetic auth user");
  const put = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users/${row.id}`, {
    method: "PUT",
    headers: { apikey: E2E_SERVICE_ROLE_KEY, Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!put.ok) throw new Error(`jwtFor: set password failed ${put.status}`);
  const res = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon(), "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`jwtFor: token grant failed ${res.status}`);
  return { token: ((await res.json()) as { access_token: string }).access_token, userId: row.id };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed PostgREST/Flight bodies in a probe
export type RpcResult = { status: number; body: any };
export async function rpc(token: string | null, fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  const res = await fetch(`${E2E_SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: anon(), Authorization: `Bearer ${token ?? anon()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed PostgREST/Flight bodies in a probe
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body };
}

export const saveRole = (t: string | null, studio: string, version: number | null, changes: object, reason: string | null = null, confirmed = false) =>
  rpc(t, "save_role_permissions", { p_studio: studio, p_expected_version: version, p_changes: changes, p_reason: reason, p_sensitive_confirmed: confirmed });
export const previewRole = (t: string | null, studio: string, changes: object) => rpc(t, "preview_role_changes", { p_studio: studio, p_changes: changes });
export const getRoles = (t: string | null, studio: string) => rpc(t, "get_role_permissions", { p_studio: studio });
export const auditRows = (t: string | null, studio: string) => rpc(t, "list_permission_audit", { p_studio: studio, p_limit: 50, p_before: null });
export const can = async (t: string | null, studio: string, key: string, o: { client?: string; appt?: string; pract?: string } = {}) =>
  (await rpc(t, "has_studio_permission", { p_studio: studio, p_key: key, p_client: o.client ?? null, p_appointment: o.appt ?? null, p_practitioner: o.pract ?? null })).body === true;
export const adoptDefaults = (t: string | null, studio: string, version: number, reason: string | null) =>
  rpc(t, "adopt_new_defaults", { p_studio: studio, p_expected_version: version, p_reason: reason });
export const resetRole = (t: string | null, studio: string, role: string, version: number, reason: string | null) =>
  rpc(t, "reset_role_to_defaults", { p_studio: studio, p_role: role, p_expected_version: version, p_reason: reason });
