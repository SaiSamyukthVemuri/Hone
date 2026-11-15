import { describe, expect, it } from "vitest";
import { readLastVisits, formatStudioDate, LAST_VISIT_DEFINITION, RECENT_WINDOW_DAYS } from "@/lib/clients/last-visit";
import { readCurrentIntake, readDirectoryClients, readNextAppointments, DIRECTORY_CLIENT_COLUMNS } from "@/lib/clients/directory-read";

type Call = { table: string; cols: string; ops: Array<[string, unknown[]]> };
type Script = (call: Call, block: number) => { data: unknown; error: unknown };

/** A chainable fake that records every call and answers from a script. */
function fake(script: Script) {
  const calls: Call[] = [];
  const supabase = {
    from(table: string) {
      return {
        select(cols: string) {
          const call: Call = { table, cols, ops: [] };
          calls.push(call);
          const q: Record<string, unknown> = {};
          for (const m of ["eq", "neq", "lte", "gte", "lt", "gt", "is", "not", "in", "order"])
            q[m] = (...a: unknown[]) => { call.ops.push([m, a]); return q; };
          q.range = async (a: number, b: number) => { call.ops.push(["range", [a, b]]); return script(call, Math.floor(a / 1000)); };
          return q;
        },
      };
    },
  };
  return { supabase: supabase as never, calls };
}

describe("last visit (R2): the later of a live non-void past session and a completed past appointment", () => {
  const NOW = "2030-06-01T00:00:00Z";
  it("takes the later source per client, and states the definition", () => {
    const { supabase, calls } = fake((c) => ({
      data: c.table === "sessions"
        ? [{ client_id: "a", started_at: "2030-01-01T00:00:00Z" }, { client_id: "b", started_at: "2030-03-01T00:00:00Z" }]
        : [{ client_id: "a", starts_at: "2030-02-01T00:00:00Z" }, { client_id: "b", starts_at: "2030-01-01T00:00:00Z" }, { client_id: "c", starts_at: "2029-12-01T00:00:00Z" }],
      error: null,
    }));
    return readLastVisits(supabase, "s", ["a", "b", "c", "a"], NOW).then((r) => {
      expect(r).toEqual({ ok: true, value: new Map([["a", "2030-02-01T00:00:00Z"], ["b", "2030-03-01T00:00:00Z"], ["c", "2029-12-01T00:00:00Z"]]) });
      // ONE batched read per source for the whole page, never per client.
      expect(calls.map((c) => c.table).sort()).toEqual(["appointments", "sessions"]);
      const ops = (t: string) => calls.find((c) => c.table === t)!.ops.map(([m, a]) => `${m}:${(a as unknown[]).join(",")}`);
      expect(ops("sessions")).toEqual(expect.arrayContaining(["is:deleted_at,", "neq:record_status,void", `lte:started_at,${NOW}`, "in:client_id,a,b,c"]));
      expect(ops("appointments")).toEqual(expect.arrayContaining(["eq:status,completed", `lte:starts_at,${NOW}`]));
      expect(LAST_VISIT_DEFINITION).toMatch(/session/);
      expect(LAST_VISIT_DEFINITION).toMatch(/completed appointment/);
    });
  });
  it("either source failing makes the answer unavailable, never a partial 'no visit'", async () => {
    for (const bad of ["sessions", "appointments"]) {
      const { supabase } = fake((c) => (c.table === bad ? { data: null, error: { message: "boom" } } : { data: [], error: null }));
      expect(await readLastVisits(supabase, "s", ["a"], NOW)).toEqual({ ok: false });
    }
  });
  it("more rows than the bound is unavailable, and no clients means no reads", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ client_id: `c${i}`, started_at: "2030-01-01T00:00:00Z", starts_at: "2030-01-01T00:00:00Z" }));
    expect(await readLastVisits(fake(() => ({ data: full, error: null })).supabase, "s", ["a"], NOW)).toEqual({ ok: false });
    const { supabase, calls } = fake(() => ({ data: [], error: null }));
    expect(await readLastVisits(supabase, "s", [], NOW)).toEqual({ ok: true, value: new Map() });
    expect(calls).toHaveLength(0);
  });
});

describe("directory reads", () => {
  it("clients: explicit columns, fixed error message with no values in it (S6)", async () => {
    expect(DIRECTORY_CLIENT_COLUMNS).toBe("id, name, pronouns, email, phone, archived_at");
    const { supabase, calls } = fake((c) => ({ data: c.ops.some(([m]) => m === "gt") ? [] : [{ id: "1", name: "N" }], error: null }));
    expect(await readDirectoryClients(supabase, "s", false)).toEqual([{ id: "1", name: "N" }]);
    expect(calls[0].cols).toContain(DIRECTORY_CLIENT_COLUMNS);
    expect(calls[0].cols).not.toContain("*");
    const failing = fake(() => ({ data: null, error: { code: "XX", message: "secret@example.test +1 555 0100" } }));
    await expect(readDirectoryClients(failing.supabase, "s", false)).rejects.toThrow(/^Failed to load clients$/);
    await expect(readDirectoryClients(failing.supabase, "s", true)).rejects.toThrow(/^Failed to load archived clients$/);
  });
  it("next appointments: earliest confirmed future start per client; failure is null, not empty", async () => {
    const ok = fake(() => ({ data: [{ client_id: "a", starts_at: "2031-01-01T00:00:00Z" }, { client_id: "a", starts_at: "2030-07-01T00:00:00Z" }], error: null }));
    expect(await readNextAppointments(ok.supabase, "s", "2030-06-01T00:00:00Z")).toEqual(new Map([["a", "2030-07-01T00:00:00Z"]]));
    expect(ok.calls[0].ops).toEqual(expect.arrayContaining([["eq", ["status", "confirmed"]], ["gt", ["starts_at", "2030-06-01T00:00:00Z"]]]));
    expect(await readNextAppointments(fake(() => ({ data: null, error: { message: "x" } })).supabase, "s", "n")).toBeNull();
  });
  it("intake: the newest non-deleted form decides (canonical rule); failure is null", async () => {
    const rows = [
      { client_id: "a", status: "reviewed", created_at: "2030-03-01T00:00:00Z" },
      { client_id: "a", status: "submitted", created_at: "2030-01-01T00:00:00Z" },
      { client_id: "b", status: "submitted", created_at: "2030-01-01T00:00:00Z" },
    ];
    const ok = fake(() => ({ data: rows, error: null }));
    expect(await readCurrentIntake(ok.supabase, "s")).toEqual(new Map([["a", "reviewed"], ["b", "submitted"]]));
    expect(ok.calls[0].cols).toBe("client_id, status, created_at");
    expect(ok.calls[0].ops).toEqual(expect.arrayContaining([["is", ["deleted_at", null]]]));
    expect(await readCurrentIntake(fake(() => ({ data: null, error: { message: "x" } })).supabase, "s")).toBeNull();
  });
});

describe("bounded reads (Insurance K1, K2, K4)", () => {
  const NOW = "2030-06-01T00:00:00Z";
  const ops = (c: Call) => c.ops.map(([m, a]) => `${m}:${(a as unknown[]).join(",")}`);

  it("scoped next-appointment and intake reads are limited to the page's clients, and end with an id tie-break", async () => {
    const next = fake(() => ({ data: [], error: null }));
    await readNextAppointments(next.supabase, "s", NOW, ["a", "b"]);
    expect(ops(next.calls[0])).toContain("in:client_id,a,b");
    expect(next.calls[0].ops.filter(([m]) => m === "order").map(([, a]) => (a as unknown[])[0])).toEqual(["starts_at", "id"]);
    const intake = fake(() => ({ data: [], error: null }));
    await readCurrentIntake(intake.supabase, "s", ["a"]);
    expect(ops(intake.calls[0])).toContain("in:client_id,a");
    expect(intake.calls[0].ops.filter(([m]) => m === "order").map(([, a]) => (a as unknown[])[0])).toEqual(["created_at", "id"]);
    // The unscoped (whole-studio) read has no client filter and the same tie-break.
    const whole = fake(() => ({ data: [], error: null }));
    await readCurrentIntake(whole.supabase, "s");
    expect(whole.calls[0].ops.some(([m]) => m === "in")).toBe(false);
    // No clients means no read at all.
    const none = fake(() => ({ data: [], error: null }));
    expect(await readNextAppointments(none.supabase, "s", NOW, [])).toEqual(new Map());
    expect(await readCurrentIntake(none.supabase, "s", [])).toEqual(new Map());
    expect(none.calls).toHaveLength(0);
  });

  it("last visit: a client with a recent visit is final after the recent window; only the rest read older history", async () => {
    const windowStart = new Date(Date.parse(NOW) - RECENT_WINDOW_DAYS * 86_400_000).toISOString();
    const { supabase, calls } = fake((c) => {
      const older = c.ops.some(([m]) => m === "lt");
      if (!older) return { data: c.table === "sessions" ? [{ client_id: "a", started_at: "2030-05-01T00:00:00Z" }] : [], error: null };
      return { data: c.table === "sessions" ? [{ client_id: "b", started_at: "2025-01-01T00:00:00Z" }] : [], error: null };
    });
    const r = await readLastVisits(supabase, "s", ["a", "b", "c"], NOW);
    expect(r).toEqual({ ok: true, value: new Map([["a", "2030-05-01T00:00:00Z"], ["b", "2025-01-01T00:00:00Z"]]) });
    const recent = calls.filter((c) => c.ops.some(([m]) => m === "gte"));
    const olderCalls = calls.filter((c) => c.ops.some(([m]) => m === "lt"));
    expect(recent).toHaveLength(2);
    expect(recent.every((c) => ops(c).includes(`gte:${c.table === "sessions" ? "started_at" : "starts_at"},${windowStart}`))).toBe(true);
    // Older history is read ONLY for the clients with no recent hit.
    expect(olderCalls).toHaveLength(2);
    expect(olderCalls.every((c) => ops(c).includes("in:client_id,b,c"))).toBe(true);
    // Every ordered read ends with an id tie-break.
    for (const c of calls) expect(c.ops.filter(([m]) => m === "order").map(([, a]) => (a as unknown[])[0]).slice(-1)).toEqual(["id"]);
  });

  it("when every client has a recent visit, older history is never read", async () => {
    const { supabase, calls } = fake((c) => ({ data: c.table === "sessions" ? [{ client_id: "a", started_at: "2030-05-01T00:00:00Z" }] : [], error: null }));
    await readLastVisits(supabase, "s", ["a"], NOW);
    expect(calls.some((c) => c.ops.some(([m]) => m === "lt"))).toBe(false);
  });

  it("a failed or overflowing older read is unavailable, never 'no visit'", async () => {
    const { supabase } = fake((c) => (c.ops.some(([m]) => m === "lt") ? { data: null, error: { message: "x" } } : { data: [], error: null }));
    expect(await readLastVisits(supabase, "s", ["a"], NOW)).toEqual({ ok: false });
  });
});

describe("last visit date is the studio's date, formatted on the server (K3)", () => {
  it("the same instant is a different day in different studio timezones", () => {
    const iso = "2030-03-02T03:30:00Z";
    expect(formatStudioDate(iso, "America/Los_Angeles")).toBe("Mar 1, 2030");
    expect(formatStudioDate(iso, "Pacific/Auckland")).toBe("Mar 2, 2030");
    expect(formatStudioDate("not a date", "UTC")).toBe("");
    expect(formatStudioDate(iso, "Not/AZone")).toBe("Mar 2, 2030");
  });
});
