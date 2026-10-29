import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  E2E_SERVICE_ROLE_KEY,
  E2E_SUPABASE_URL,
  E2E_WEB_SERVER_ENV,
} from "@/e2e/helpers/local-env";
import { adminQuery, seedStudio, type SeededStudio } from "@/tests/db/helpers/harness";

// ===========================================================================
// #1172 (HON-12) two-studio regression, through the ACTUAL authenticated paths.
//
// Studio A's member holds a REAL GoTrue session (password sign-in, session in
// the cookie jar that the app's own createClient() reads). Studio B has a
// disinfectant record. Supplying B's record id must neither read nor edit it:
//   - getDisinfectantRecordForNotice (the Records page's notice read),
//   - the RLS-scoped select/update with the same createClient the page and the
//     action use, WITHOUT any studio filter (RLS alone), and
//   - updateDisinfectantRecordAction itself, driven with A's session.
//
// EXISTING RLS EVIDENCE this builds on (reused, not duplicated):
//   - policies: supabase/migrations/0085_record_keeping_and_probe_lot_numbers.sql
//     "record_keeping_disinfectants: members select / insert / update" (all
//     is_studio_member(studio_id); no delete policy; update has USING + WITH CHECK).
//   - tests/migrations/0087-clinical-rls-delete-hardening.test.ts (no FOR ALL
//     policy after 0087; every UPDATE policy has USING and WITH CHECK).
//   - tests/db/cross-studio-isolation.db.test.ts ("practitioner A cannot read
//     studio B rows": exposure incidents and audit events, the same helpers).
//   Missing until this file: the disinfectants table itself read/edited by id.
// Synthetic data only.
// ===========================================================================

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const B_NAME = `B-private-jar-${randomUUID().slice(0, 8)}`;

let a: SeededStudio;
let b: SeededStudio;
let aRec: string;
let bRec: string;
let getForNotice: (studioId: string, id: string) => Promise<{ id: string } | null>;
let updateAction: (fd: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
let serverClient: () => Promise<{
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: string) => PromiseLike<{ data: Array<{ id: string }> | null; error: unknown }>;
    } & PromiseLike<{ data: Array<{ id: string }> | null; error: unknown }>;
    update: (v: Record<string, unknown>) => {
      eq: (k: string, v: string) => {
        select: (c: string) => PromiseLike<{ data: Array<{ id: string }> | null; error: unknown }>;
      };
    };
  };
}>;

const bRowJson = async () =>
  (await adminQuery(`select row_to_json(t)::text as j from public.record_keeping_disinfectants t where id = $1`, [bRec]))
    .rows[0]?.j as string;
const bAuditCount = async () =>
  Number(
    (await adminQuery(`select count(*)::int as n from public.record_keeping_audit_events where studio_id = $1`, [b.studioId]))
      .rows[0].n,
  );

function form(recordId: string, name: string): FormData {
  const fd = new FormData();
  fd.set("record_id", recordId);
  fd.set("date_prepared", "2026-10-01");
  fd.set("disinfectant_name", name);
  fd.set("date_discarded", "2026-10-20");
  return fd;
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;

  a = await seedStudio(`dis-a-${randomUUID().slice(0, 6)}`);
  b = await seedStudio(`dis-b-${randomUUID().slice(0, 6)}`);
  aRec = randomUUID();
  bRec = randomUUID();
  for (const [studio, id, name] of [
    [a, aRec, "A synthetic jar"],
    [b, bRec, B_NAME],
  ] as const) {
    await adminQuery(
      `insert into public.record_keeping_disinfectants
         (id, studio_id, date_prepared, disinfectant_name, discard_due_date)
       values ($1, $2, '2019-12-01', $3, '2020-01-01')`,
      [id, studio.studioId, name],
    );
  }

  // A's member: a real GoTrue user whose session is what the app's createClient() reads.
  const email = `dis2-${randomUUID().slice(0, 8)}@harness.local`;
  const password = `Pw-${randomUUID()}`;
  const created = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: E2E_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`local GoTrue createUser failed: ${created.status}`);
  const authUser = (await created.json()) as { id: string };
  await adminQuery("update public.practitioners set user_id = $2, email = $3 where id = $1", [
    a.practitionerId,
    authUser.id,
    email,
  ]);
  const token = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!token.ok) throw new Error(`local sign-in failed: ${token.status}`);
  const session = (await token.json()) as { access_token: string; refresh_token: string };
  const writer = createServerClient(E2E_SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list: Array<{ name: string; value: string }>) =>
        list.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  await writer.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (jar.size === 0) throw new Error("no auth cookie was written");

  getForNotice = (await import("@/lib/record-keeping/queries")).getDisinfectantRecordForNotice as typeof getForNotice;
  updateAction = (await import("@/app/(app)/records/actions")).updateDisinfectantRecordAction as typeof updateAction;
  serverClient = (await import("@/lib/supabase/server")).createClient as unknown as typeof serverClient;
}, 120_000);

describe("ground truth: the absence below is RLS, not a missing row", () => {
  it("B's record exists and belongs to B", async () => {
    const r = await adminQuery(`select studio_id from public.record_keeping_disinfectants where id = $1`, [bRec]);
    expect(r.rows[0]?.studio_id).toBe(b.studioId);
  });
});

describe("READ: A's member supplying B's record id", () => {
  it("getDisinfectantRecordForNotice(A's studio, B's id) is null", async () => {
    expect(await getForNotice(a.studioId, bRec)).toBeNull();
  });
  it("even with B's studio id supplied as well, RLS alone returns null", async () => {
    expect(await getForNotice(b.studioId, bRec)).toBeNull();
  });
  it("the RLS-scoped select by B's id (no studio filter) returns no row and no error", async () => {
    const sb = await serverClient();
    const { data, error } = await sb.from("record_keeping_disinfectants").select("id").eq("id", bRec);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
  it("the unfiltered RLS-scoped select shows only A's own record", async () => {
    const sb = await serverClient();
    const { data, error } = await sb.from("record_keeping_disinfectants").select("id");
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([aRec]);
  });
  it("control: A's own record is read by the same function", async () => {
    expect((await getForNotice(a.studioId, aRec))?.id).toBe(aRec);
  });
});

describe("EDIT: A's member supplying B's record id", () => {
  it("the RLS-scoped update by B's id (no studio filter) matches nothing and B is byte-identical", async () => {
    const before = await bRowJson();
    const audits = await bAuditCount();
    const sb = await serverClient();
    const { data, error } = await sb
      .from("record_keeping_disinfectants")
      .update({ date_discarded: "2026-10-20", disinfectant_name: "HIJACKED" })
      .eq("id", bRec)
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(await bRowJson()).toBe(before);
    expect(await bAuditCount()).toBe(audits);
  });
  it("updateDisinfectantRecordAction with B's id reports failure, leaks nothing, and B is byte-identical", async () => {
    const before = await bRowJson();
    const audits = await bAuditCount();
    const res = await updateAction(form(bRec, "HIJACKED"));
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(B_NAME);
    expect(JSON.stringify(res)).not.toContain(bRec);
    expect(await bRowJson()).toBe(before);
    expect(await bAuditCount()).toBe(audits);
    expect(before).toContain(B_NAME);
  });
  it("an unknown id also reports failure", async () => {
    const res = await updateAction(form(randomUUID(), "x"));
    expect(res.ok).toBe(false);
  });
  it("control: the same action on A's own record succeeds and persists", async () => {
    const res = await updateAction(form(aRec, "A synthetic jar"));
    expect(res).toEqual({ ok: true });
    const r = await adminQuery(
      `select date_discarded::text as d from public.record_keeping_disinfectants where id = $1`,
      [aRec],
    );
    expect(r.rows[0]?.d).toBe("2026-10-20");
  });
});
