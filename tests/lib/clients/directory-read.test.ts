import { describe, expect, it } from "vitest";
import { readLastVisits, LAST_VISIT_DEFINITION } from "@/lib/clients/last-visit";
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
          for (const m of ["eq", "neq", "lte", "gt", "is", "not", "in", "order"])
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
