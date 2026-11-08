import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IdempotentEmailTransport } from "@/lib/email/new-client-waitlist-send";

vi.mock("server-only", () => ({}));
import { dispatchDeclineOwnerEmail, getDeclineEmailStatus } from "@/lib/waitlist/decline-owner-email";
import { DECLINE_OWNER_EMAIL_MAX_ATTEMPTS, DECLINE_OWNER_EMAIL_RETRY_WINDOW_HOURS } from "@/lib/waitlist/decline-owner-email-gate";
import { buildWaitlistDeclineOwnerEmail, WAITLIST_DECLINE_OWNER_BODY, WAITLIST_DECLINE_OWNER_SUBJECT } from "@/lib/email/templates/waitlist-decline-owner";

// HON-7 item 4. Synthetic ids and addresses only. The fake below models the outbox table, the practitioners table and the auth user read.

const STUDIO = "11111111-1111-4111-8111-111111111111";
const INV = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-09T12:00:00.000Z");
const SINCE = "2026-11-09T00:00:00.000Z";

type Out = { id: string; studio_id: string; invitation_id: string; recipient_practitioner_id: string; status: string; attempt_count: number; claimed_at: string | null; created_at: string; last_error_code?: string | null; provider_message_id?: string | null; sent_at?: string | null };
type Prac = { id: string; studio_id: string; role: string; active: boolean; user_id: string | null };
type AuthUser = { email: string | null; email_confirmed_at: string | null };

function world() {
  const outbox: Out[] = [];
  const pracs = new Map<string, Prac>();
  const users = new Map<string, AuthUser>();
  const writes: Array<Record<string, unknown>> = [];
  const sends: Array<{ to: string; subject: string; text: string; html: string; key: string }> = [];

  function table(name: string) {
    const f: Array<(r: Record<string, unknown>) => boolean> = [];
    let patch: Record<string, unknown> | null = null;
    let limit = Infinity;
    const q: Record<string, unknown> = {};
    const rows = () => (name === "practitioners" ? [...pracs.values()] : outbox) as unknown as Array<Record<string, unknown>>;
    const run = () => {
      const hit = rows().filter((r) => f.every((p) => p(r)));
      if (patch) {
        writes.push(patch);
        for (const r of hit) Object.assign(r, patch);
      }
      // Copies, like a database: a reader must not see a row change under it.
      return hit.slice(0, limit).map((r) => ({ ...r }));
    };
    q.select = () => q;
    q.update = (p: Record<string, unknown>) => { patch = p; return q; };
    q.eq = (c: string, v: unknown) => { f.push((r) => r[c] === v); return q; };
    q.is = (c: string, v: unknown) => { f.push((r) => r[c] === v); return q; };
    const cmp = (a: unknown, b: unknown): number | null => {
      if (a === null || a === undefined) return null; // SQL: a comparison with NULL is never true
      if (typeof a === "number" && typeof b === "number") return a - b;
      return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    };
    q.gte = (c: string, v: unknown) => { f.push((r) => { const d = cmp(r[c], v); return d !== null && d >= 0; }); return q; };
    q.lt = (c: string, v: unknown) => { f.push((r) => { const d = cmp(r[c], v); return d !== null && d < 0; }); return q; };
    // the real filter string is `status.in.(held,failed),and(status.eq.sending,claimed_at.lt.<iso>)`
    q.or = (expr: string) => {
      const stale = /claimed_at\.lt\.([^)]+)\)/.exec(expr)?.[1] ?? "";
      f.push((r) => r.status === "held" || r.status === "failed" || (r.status === "sending" && !!r.claimed_at && String(r.claimed_at) < stale));
      return q;
    };
    q.order = () => q;
    q.limit = (n: number) => { limit = n; return q; };
    q.maybeSingle = async () => ({ data: run()[0] ?? null, error: null });
    q.then = (res: (v: unknown) => unknown) => {
      const data = run();
      return Promise.resolve({ data, error: null, count: data.length }).then(res);
    };
    return q;
  }
  const admin = {
    from: (n: string) => table(n),
    auth: {
      admin: {
        getUserById: async (id: string) => {
          const u = users.get(id);
          return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: "x" } };
        },
      },
    },
  } as unknown as SupabaseClient;

  let mode: "accept" | "reject" | "ambiguous" = "accept";
  const transport: IdempotentEmailTransport = {
    emails: {
      send: async (payload, options) => {
        sends.push({ to: payload.to, subject: payload.subject, text: payload.text, html: payload.html, key: options?.idempotencyKey ?? "" });
        if (mode === "reject") return { data: null, error: { name: "validation_error", message: "synthetic" } };
        if (mode === "ambiguous") return { data: null, error: { name: "concurrent_idempotent_requests" } };
        return { data: { id: `msg-${sends.length}` }, error: null };
      },
    },
  };

  let n = 0;
  function owner(opts: { confirmed?: boolean; role?: string; active?: boolean; studio?: string; status?: string; created?: string } = {}) {
    n += 1;
    const pid = `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const uid = `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
    pracs.set(pid, { id: pid, studio_id: opts.studio ?? STUDIO, role: opts.role ?? "owner", active: opts.active ?? true, user_id: uid });
    users.set(uid, { email: `owner${n}@example.test`, email_confirmed_at: opts.confirmed === false ? null : "2026-01-01T00:00:00Z" });
    outbox.push({ id: `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`, studio_id: STUDIO, invitation_id: INV, recipient_practitioner_id: pid, status: opts.status ?? "held", attempt_count: 0, claimed_at: null, created_at: opts.created ?? "2026-11-09T11:00:00.000Z" });
    return { pid, uid, row: outbox[outbox.length - 1] };
  }
  const run = (scope: { invitationId?: string } = {}) =>
    dispatchDeclineOwnerEmail({ admin, transport, now: () => NOW, appOrigin: () => "https://hone.example.test" }, scope);
  return { admin, outbox, pracs, users, sends, writes, owner, run, setMode: (m: typeof mode) => { mode = m; } };
}

const ON = () => { process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_ENABLED = "true"; process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE = SINCE; };
beforeEach(ON);
afterEach(() => { delete process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_ENABLED; delete process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE; vi.restoreAllMocks(); });

describe("activation", () => {
  it.each([[undefined], ["TRUE"], ["1"], ["yes"], [" true"], [""]])("flag value %j sends nothing", async (v) => {
    if (v === undefined) delete process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_ENABLED; else process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_ENABLED = v;
    const w = world(); w.owner();
    expect(await w.run()).toEqual({ sent: 0, failed: 0, cancelled: 0, skipped: 0 });
    expect(w.sends).toHaveLength(0);
    expect(w.outbox[0].status).toBe("held");
  });
  it.each([[undefined], [""], ["yesterday"], ["2026-13-45T00:00:00Z"]])("a missing or malformed SINCE %j sends nothing", async (v) => {
    if (v === undefined) delete process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE; else process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE = v;
    const w = world(); w.owner();
    await w.run();
    expect(w.sends).toHaveLength(0);
  });
  it("a row held from before activation is never sent, even later", async () => {
    const w = world(); w.owner({ created: "2026-11-08T23:59:59.000Z" });
    await w.run();
    expect(w.sends).toHaveLength(0);
    expect(w.outbox[0].status).toBe("held");
    expect(w.outbox[0].attempt_count).toBe(0);
  });
});

describe("one email to each current verified owner", () => {
  it("sends once per owner row, to that owner's confirmed address, and records it", async () => {
    const w = world(); const a = w.owner(); const b = w.owner();
    expect(await w.run({ invitationId: INV })).toMatchObject({ sent: 2, failed: 0 });
    expect(w.sends.map((s) => s.to).sort()).toEqual(["owner1@example.test", "owner2@example.test"]);
    expect(a.row).toMatchObject({ status: "sent", attempt_count: 1, provider_message_id: "msg-1" });
    expect(b.row.status).toBe("sent");
    expect(new Set(w.sends.map((s) => s.key)).size).toBe(2);
  });
  it("the idempotency key names the invitation AND the recipient, not only the payload", async () => {
    const w = world(); const a = w.owner();
    await w.run();
    expect(w.sends[0].key).toContain(`decline-owner/${INV}/${a.pid}`);
  });
  it("two overlapping invocations send once per row", async () => {
    const w = world(); w.owner(); w.owner();
    await Promise.all([w.run(), w.run()]);
    expect(w.sends).toHaveLength(2);
  });
  it("a second sweep sends nothing more", async () => {
    const w = world(); w.owner(); w.owner();
    await w.run(); await w.run();
    expect(w.sends).toHaveLength(2);
  });
  it("the email says only what Sam approved and names no one", async () => {
    const w = world(); w.owner();
    await w.run();
    const m = w.sends[0];
    expect(m.subject).toBe("A waitlist response needs your attention");
    expect(m.text).toContain(WAITLIST_DECLINE_OWNER_BODY);
    expect(m.html).toContain("Review response");
    expect(m.text).toContain("https://hone.example.test/settings/waitlist?followup=1");
    const b = buildWaitlistDeclineOwnerEmail({ appOrigin: "https://hone.example.test/" });
    expect(b.subject).toBe(WAITLIST_DECLINE_OWNER_SUBJECT);
    expect(b.text).toBe(buildWaitlistDeclineOwnerEmail({ appOrigin: "https://hone.example.test" }).text);
  });
});

describe("the recipient is re-checked at send time", () => {
  it.each([
    ["no longer an owner", { role: "practitioner" }, "not_owner"],
    ["deactivated", { active: false }, "not_owner"],
    ["now in another studio", { studio: "99999999-9999-4999-8999-999999999999" }, "not_owner"],
    ["email not confirmed", { confirmed: false }, "unverified"],
  ])("%s: cancelled, nothing sent", async (_n, opts, code) => {
    const w = world(); const o = w.owner(opts);
    expect(await w.run()).toMatchObject({ cancelled: 1, sent: 0 });
    expect(w.sends).toHaveLength(0);
    expect(o.row).toMatchObject({ status: "cancelled", last_error_code: code });
  });
  it("a deleted practitioner is cancelled as no_recipient", async () => {
    const w = world(); const o = w.owner(); w.pracs.delete(o.pid);
    await w.run();
    expect(o.row).toMatchObject({ status: "cancelled", last_error_code: "no_recipient" });
  });
  it("one ineligible owner does not stop the other", async () => {
    const w = world(); w.owner({ confirmed: false }); const ok = w.owner();
    expect(await w.run()).toMatchObject({ sent: 1, cancelled: 1 });
    expect(ok.row.status).toBe("sent");
  });
});

describe("failure, retry, and no duplicates", () => {
  it("a provider rejection is recorded with a closed code and no provider text", async () => {
    const w = world(); const o = w.owner(); w.setMode("reject");
    expect(await w.run()).toMatchObject({ failed: 1 });
    expect(o.row).toMatchObject({ status: "failed", last_error_code: "provider_rejected" });
    expect(JSON.stringify(w.writes)).not.toContain("synthetic");
  });
  it("an ambiguous send is a retryable timeout and retries under the SAME key", async () => {
    const w = world(); const o = w.owner(); w.setMode("ambiguous");
    await w.run();
    expect(o.row).toMatchObject({ status: "failed", last_error_code: "timeout" });
    const firstKey = w.sends[0].key;
    w.setMode("accept");
    await w.run();
    expect(o.row.status).toBe("sent");
    expect(w.sends[w.sends.length - 1].key).toBe(firstKey);
  });
  it("the reviewed retry budget is 3 attempts within 24 hours, as single constants", () => {
    expect(DECLINE_OWNER_EMAIL_MAX_ATTEMPTS).toBe(3);
    expect(DECLINE_OWNER_EMAIL_RETRY_WINDOW_HOURS).toBe(24);
  });
  it("stops after 3 attempts however many sweeps run, and stays failed", async () => {
    const w = world(); const o = w.owner(); w.setMode("reject");
    for (let i = 0; i < 12; i++) await w.run();
    expect(o.row.attempt_count).toBe(3);
    expect(o.row.status).toBe("failed");
    expect(w.sends).toHaveLength(3);
  });
  it("makes no attempt after 24 hours from the row's creation, and a never-sent held row becomes failed", async () => {
    process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE = "2026-11-01T00:00:00.000Z";
    const w = world(); const o = w.owner({ created: "2026-11-08T11:59:00.000Z" });
    await w.run();
    expect(w.sends).toHaveLength(0);
    expect(o.row).toMatchObject({ status: "failed", attempt_count: 0 });
  });
  it("a row just inside the window is still attempted", async () => {
    process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE = "2026-11-01T00:00:00.000Z";
    const w = world(); const o = w.owner({ created: "2026-11-08T12:01:00.000Z" });
    await w.run();
    expect(o.row.status).toBe("sent");
  });
  it("a failed row older than the window is not retried", async () => {
    process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE = "2026-11-01T00:00:00.000Z";
    const w = world(); const o = w.owner({ status: "failed", created: "2026-11-08T11:00:00.000Z" });
    o.row.attempt_count = 1;
    await w.run();
    expect(w.sends).toHaveLength(0);
    expect(o.row.attempt_count).toBe(1);
  });
  it("a row abandoned mid-send on its last attempt does not stay sending forever", async () => {
    const w = world(); const o = w.owner({ status: "sending" });
    o.row.attempt_count = 3; o.row.claimed_at = "2026-11-09T11:00:00.000Z";
    await w.run();
    expect(w.sends).toHaveLength(0);
    expect(o.row.status).toBe("failed");
  });
  it("rows from before activation are not expired either", async () => {
    const w = world(); const o = w.owner({ created: "2026-11-01T00:00:00.000Z" });
    await w.run();
    expect(o.row.status).toBe("held");
  });
  it("is the same at any cadence: the outcome depends on the row, not on how many sweeps ran", async () => {
    const a = world(); const oa = a.owner(); a.setMode("reject");
    for (let i = 0; i < 3; i++) await a.run();
    const b = world(); const ob = b.owner(); b.setMode("reject");
    for (let i = 0; i < 40; i++) await b.run();
    expect([oa.row.status, oa.row.attempt_count]).toEqual([ob.row.status, ob.row.attempt_count]);
  });
  it("a row abandoned mid-send is reclaimed only after the stale window", async () => {
    const w = world(); const o = w.owner({ status: "sending" });
    o.row.claimed_at = "2026-11-09T11:58:00.000Z";
    await w.run();
    expect(w.sends).toHaveLength(0);
    o.row.claimed_at = "2026-11-09T11:30:00.000Z";
    await w.run();
    expect(w.sends).toHaveLength(1);
    expect(o.row.status).toBe("sent");
  });
  it("sent and cancelled rows are never claimed again", async () => {
    const w = world(); w.owner({ status: "sent" }); w.owner({ status: "cancelled" });
    await w.run();
    expect(w.sends).toHaveLength(0);
  });
  it("never throws, even when the database client does", async () => {
    const boom = { from: () => { throw new Error("synthetic"); } } as unknown as SupabaseClient;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(dispatchDeclineOwnerEmail({ admin: boom })).resolves.toEqual({ sent: 0, failed: 0, cancelled: 0, skipped: 0 });
    expect(spy).toHaveBeenCalled();
  });
});

describe("what is written and logged", () => {
  it("log lines carry only a fixed event and a code or count", async () => {
    const w = world(); w.owner(); w.setMode("reject");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await w.run();
    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toMatch(/@|owner\d|synthetic|aaaaaaaa|bbbbbbbb/);
  });
  it("the outbox patch never carries an address or any body text", async () => {
    const w = world(); w.owner();
    await w.run();
    const s = JSON.stringify(w.writes);
    expect(s).not.toMatch(/@example\.test|Someone responded|Review response/);
  });
});

describe("status shown in Hone", () => {
  it("counts failed rows only, since activation, and nothing else", async () => {
    const w = world(); w.owner({ status: "failed" }); w.owner({ status: "sent" }); w.owner({ status: "failed", created: "2026-11-08T00:00:00.000Z" });
    expect(await getDeclineEmailStatus(w.admin, STUDIO)).toEqual({ kind: "ok", failed: 1 });
  });
  it("is zero while the feature is off", async () => {
    delete process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_ENABLED;
    const w = world(); w.owner({ status: "failed" });
    expect(await getDeclineEmailStatus(w.admin, STUDIO)).toEqual({ kind: "ok", failed: 0 });
  });
  it("a read error is unknown, not zero", async () => {
    const bad = { from: () => { throw new Error("x"); } } as unknown as SupabaseClient;
    expect(await getDeclineEmailStatus(bad, STUDIO)).toEqual({ kind: "unknown" });
  });
});
