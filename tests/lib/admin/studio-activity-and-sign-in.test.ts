import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  STUDIO_ACTIVITY_SOURCES,
  STUDIO_ACTIVITY_WINDOW_MS,
  classifyStudioActivity,
  loadStudioActivity,
} from "@/lib/admin/studio-activity";
import { STAFF_SIGN_IN_CAP, loadStaffSignIns, signInState } from "@/lib/admin/staff-sign-in";

// HON-82 phase 1: operator-only, read-only studio activity (24h window) and staff last sign-in (name + role only).

const NOW = Date.parse("2026-11-27T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("classifyStudioActivity", () => {
  it("the window is exactly 24 hours", () => expect(STUDIO_ACTIVITY_WINDOW_MS).toBe(86_400_000));
  it("inside the window is active; just outside is inactive with its time", () => {
    expect(classifyStudioActivity(hoursAgo(23.9), 0, NOW)).toEqual({ state: "active", at: hoursAgo(23.9) });
    expect(classifyStudioActivity(hoursAgo(24), 0, NOW).state).toBe("active");
    expect(classifyStudioActivity(hoursAgo(24.1), 0, NOW)).toEqual({ state: "inactive", at: hoursAgo(24.1) });
  });
  it("no rows anywhere is inactive with no time, and only when every source answered", () => {
    expect(classifyStudioActivity(null, 0, NOW)).toEqual({ state: "inactive", at: null });
    expect(classifyStudioActivity(null, 1, NOW)).toEqual({ state: "unknown", at: null });
    expect(classifyStudioActivity(hoursAgo(48), 1, NOW)).toEqual({ state: "unknown", at: null });
  });
  it("a positive that was read stays true even if another source failed", () => {
    expect(classifyStudioActivity(hoursAgo(1), 2, NOW).state).toBe("active");
  });
});

type Call = { table: string; select: string; eq: [string, unknown][]; order: string; limit: number };
function activityClient(rows: Record<string, unknown>, fail: string[] = [], throwFor: string[] = []) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      from(table: string) {
        const c: Call = { table, select: "", eq: [], order: "", limit: 0 };
        calls.push(c);
        const q: Record<string, unknown> = {};
        q.select = (s: string) => ((c.select = s), q);
        q.eq = (k: string, v: unknown) => (c.eq.push([k, v]), q);
        q.order = (col: string) => ((c.order = col), q);
        q.limit = async (n: number) => {
          c.limit = n;
          if (throwFor.includes(table)) throw new Error("boom");
          if (fail.includes(table)) return { data: null, error: { message: "x" } };
          return { data: rows[table] === undefined ? [] : [{ [c.select]: rows[table] }], error: null };
        };
        return q;
      },
    } as never,
  };
}

describe("loadStudioActivity", () => {
  it("reads only the fixed list, scoped by studio, one timestamp column each, newest first, one row", async () => {
    const { client, calls } = activityClient({ appointments: hoursAgo(30), sessions: hoursAgo(5) });
    const r = await loadStudioActivity(client, "studio-1", NOW);
    expect(r).toEqual({ state: "active", at: hoursAgo(5) });
    expect(calls.map((c) => c.table).sort()).toEqual(STUDIO_ACTIVITY_SOURCES.map((s) => s.table).sort());
    for (const c of calls) {
      expect(c.eq).toEqual([["studio_id", "studio-1"]]);
      expect(c.limit).toBe(1);
      expect(c.select).toBe(c.order); // the timestamp column alone, nothing else
      expect(c.select).toMatch(/_at$/);
    }
  });
  it("one failing or throwing source never claims inactive", async () => {
    expect((await loadStudioActivity(activityClient({}, ["sessions"]).client, "s", NOW)).state).toBe("unknown");
    expect((await loadStudioActivity(activityClient({}, [], ["appointments"]).client, "s", NOW)).state).toBe("unknown");
    expect((await loadStudioActivity(activityClient({}).client, "s", NOW)).state).toBe("inactive");
  });
});

describe("signInState", () => {
  it("never shows a failed lookup as never or as a time", () => {
    expect(signInState(null, { ok: false })).toEqual({ state: "account_removed" });
    expect(signInState("u", { ok: false })).toEqual({ state: "unknown" });
    expect(signInState("u", { ok: true, lastSignInAt: null })).toEqual({ state: "never_signed_in" });
    expect(signInState("u", { ok: true, lastSignInAt: "not a date" })).toEqual({ state: "unknown" });
    expect(signInState("u", { ok: true, lastSignInAt: hoursAgo(2) })).toEqual({ state: "signed_in", at: hoursAgo(2) });
  });
});

function staffClient(opts: {
  pracs?: unknown[]; recs?: unknown[]; invites?: unknown[]; inviteErr?: boolean; pracErr?: boolean; users?: Record<string, { last_sign_in_at?: string | null } | "error">;
}) {
  const selects: Record<string, string> = {};
  const lookups: string[] = [];
  return {
    selects, lookups,
    client: {
      from(table: string) {
        const q: Record<string, unknown> = {};
        q.select = (s: string) => ((selects[table] = s), q);
        q.eq = () => q;
        q.order = () => q;
        q.limit = async () =>
          table === "pending_invitations"
            ? opts.inviteErr ? { data: null, error: { message: "x" } } : { data: opts.invites ?? [], error: null }
            : table === "practitioners"
            ? opts.pracErr ? { data: null, error: { message: "x" } } : { data: opts.pracs ?? [], error: null }
            : { data: opts.recs ?? [], error: null };
        return q;
      },
      auth: { admin: { getUserById: async (id: string) => {
        lookups.push(id);
        const u = opts.users?.[id];
        return !u || u === "error" ? { data: null, error: { message: "x" } } : { data: { user: u }, error: null };
      } } },
    } as never,
  };
}

describe("loadStaffSignIns", () => {
  it("name and role only: the membership reads select no email or other personal column, and the report carries none", async () => {
    const { client, selects } = staffClient({
      pracs: [{ id: "p1", display_name: "Ada", role: "owner", active: true, user_id: "u1" }],
      recs: [{ id: "r1", display_name: "Bo", active: false, user_id: null }],
      users: { u1: { last_sign_in_at: hoursAgo(3) } },
    });
    const r = await loadStaffSignIns(client, "s");
    expect(selects.practitioners).toBe("id, display_name, role, active, user_id");
    expect(selects.studio_receptionists).toBe("id, display_name, active, user_id");
    expect(r.staff).toEqual([
      { key: "p:p1", displayName: "Ada", role: "owner", active: true, signIn: { state: "signed_in", at: hoursAgo(3) } },
      { key: "r:r1", displayName: "Bo", role: "receptionist", active: false, signIn: { state: "account_removed" } },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/@|u1/); // no email, no user id leaves the loader
  });
  it("a failed account lookup is Unknown; a failed membership read is unavailable, never an empty list", async () => {
    const a = await loadStaffSignIns(staffClient({ pracs: [{ id: "p", display_name: "A", role: "practitioner", active: true, user_id: "u" }], users: { u: "error" } }).client, "s");
    expect(a.staff[0].signIn).toEqual({ state: "unknown" });
    expect(await loadStaffSignIns(staffClient({ pracErr: true }).client, "s")).toEqual({ staff: [], truncated: false, unavailable: true, pendingInvites: null });
  });
  it("one lookup per distinct account, and more than the cap is reported as truncated", async () => {
    const same = [1, 2].map((i) => ({ id: `p${i}`, display_name: "A" + i, role: "practitioner", active: true, user_id: "shared" }));
    const c = staffClient({ pracs: same, users: { shared: { last_sign_in_at: hoursAgo(1) } } });
    await loadStaffSignIns(c.client, "s");
    expect(c.lookups).toEqual(["shared"]);
    const many = Array.from({ length: STAFF_SIGN_IN_CAP + 1 }, (_, i) => ({ id: `p${i}`, display_name: "N" + i, role: "practitioner", active: true, user_id: null }));
    const r = await loadStaffSignIns(staffClient({ pracs: many }).client, "s");
    expect(r.truncated).toBe(true);
    expect(r.staff).toHaveLength(STAFF_SIGN_IN_CAP);
  });
});

describe("pending invitations: counted by role only", () => {
  it("a new studio with no accepted staff still shows its pending invitations by role; the read selects the role column alone", async () => {
    const c = staffClient({ invites: [{ role: "owner" }, { role: "receptionist" }, { role: "practitioner" }, { role: "practitioner" }] });
    const r = await loadStaffSignIns(c.client, "s");
    expect(r.staff).toEqual([]);
    expect(r.pendingInvites).toEqual({ owner: 1, practitioner: 2, receptionist: 1, total: 4 });
    expect(c.selects.pending_invitations).toBe("role");
    expect(JSON.stringify(r)).not.toMatch(/@|email/);
  });
  it("a failed invitation read is null (unknown), never zero", async () => {
    const r = await loadStaffSignIns(staffClient({ inviteErr: true }).client, "s");
    expect(r.pendingInvites).toBeNull();
  });
  it("the loader reads only pending, unaccepted invitations", () => {
    const src = readFileSync(path.resolve(__dirname, "../../..", "lib/admin/staff-sign-in.ts"), "utf8");
    expect(src).toMatch(/\.from\("pending_invitations"\)[\s\S]{0,200}\.select\("role"\)[\s\S]{0,120}\.eq\("status", "pending"\)/);
  });
});

describe("source pins (operator-only, read-only)", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
  it("the two loaders never write, and the page sits under the /admin gate", () => {
    for (const f of ["lib/admin/studio-activity.ts", "lib/admin/staff-sign-in.ts"]) {
      expect(read(f).replace(/^\s*\/\/.*$/gm, "")).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    }
    expect(read("app/admin/layout.tsx")).toMatch(/isAdmin\(user\.email\)/);
  });
  it("the sections render no email, user id or client content", () => {
    const code = read("app/admin/studios/[id]/activity-sections.tsx").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/email|userId|user_id/);
  });
});
