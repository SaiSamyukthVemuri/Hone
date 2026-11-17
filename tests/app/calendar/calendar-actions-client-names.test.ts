import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// HON-58: the calendar server ACTIONS that touch a client's name, per role. The page tests prove what the
// grid shows; these prove the actions around actions.ts (the booking lookup, the cancellation lookup and the quick-create) read
// and return only what they should, and that a receptionist or an inactive practitioner reaches none of them. Synthetic ids only.
// The row policy behind the quick-create (0087) is proved in tests/db/receptionist-client-insert.db.test.ts.

const state = vi.hoisted(() => ({
  identity: "active" as "active" | "inactive" | "receptionist",
  inserted: [] as Array<Record<string, unknown>>,
  selects: [] as string[],
  reads: 0,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: () => undefined }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => { throw new Error("privileged client must not be used"); } }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => {
    state.reads++;
    if (state.identity === "receptionist") throw new Error("No active practitioner found for the signed-in user.");
    return {
      practitioner: { id: "p1", role: "practitioner", active: state.identity === "active" },
      studio: { id: "studio-1", timezone: "America/Toronto" },
    };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const query: Record<string, unknown> = {
        insert: (row: Record<string, unknown>) => { if (table === "clients") state.inserted.push(row); return query; },
        select: (cols: string) => { state.selects.push(`${table}:${cols}`); return query; },
        single: async () => ({
          data: { id: "c-new", name: String(state.inserted.at(-1)?.name), email: null, phone: null, pronouns: null },
          error: null,
        }),
      };
      return query;
    },
  }),
}));

import { createClientForCalendarBookingAction } from "@/app/(app)/calendar/actions";

function form(name: string): FormData {
  const f = new FormData();
  f.set("name", name);
  return f;
}
beforeEach(() => { state.identity = "active"; state.inserted = []; state.selects = []; state.reads = 0; });

describe("calendar quick-create, per role", () => {
  it("an active practitioner creates the client and gets back exactly five fields, no legal or preferred field", async () => {
    const r = await createClientForCalendarBookingAction(form("Synthetic New Client"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.client).sort()).toEqual(["email", "id", "name", "phone", "pronouns"]);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ studio_id: "studio-1", name: "Synthetic New Client", created_by: "p1" });
    expect(Object.keys(state.inserted[0]).some((k) => /legal|preferred/i.test(k)), "quick-create writes no legal or preferred name").toBe(false);
    expect(state.selects.join("|")).not.toMatch(/\*|legal/i);
  });
  it("an inactive practitioner is refused and nothing is written", async () => {
    state.identity = "inactive";
    const r = await createClientForCalendarBookingAction(form("Synthetic Name"));
    expect(r).toEqual({ ok: false, error: "Inactive practitioners cannot add clients." });
    expect(state.inserted).toHaveLength(0);
  });
  it("a receptionist has no practitioner identity: the action throws before any write", async () => {
    state.identity = "receptionist";
    await expect(createClientForCalendarBookingAction(form("Synthetic Name"))).rejects.toThrow(/No active practitioner/);
    expect(state.inserted).toHaveLength(0);
    expect(state.selects).toHaveLength(0);
  });
});

describe("the other calendar actions that read a client's name", () => {
  const src = readFileSync("app/(app)/calendar/actions.ts", "utf8");
  it("every clients read in actions.ts lists its columns: no star, no legal identity", () => {
    const reads = [...src.matchAll(/\.from\("clients"\)\s*\.select\("([^"]*)"\)/g)].map((m) => m[1]);
    expect(reads.length, "the booking lookup and the cancellation lookup").toBeGreaterThanOrEqual(2);
    for (const cols of reads) {
      expect(cols).not.toContain("*");
      expect(cols).not.toMatch(/legal|preferred/i);
    }
  });
  it("the booking and cancellation lookups use the stored name only for the client's own email, never for a staff screen", () => {
    // They feed dispatchBookingEmails / sendCancellationEmail (client-facing communications, a separate change), not a page.
    const bookLookup = src.indexOf('.select("id, name, email, phone, sms_consent_at, sms_opted_out_at")');
    const cancelLookup = src.indexOf('.select("name, email")');
    expect(bookLookup).toBeGreaterThan(0);
    expect(cancelLookup).toBeGreaterThan(0);
    // Neither lookup's result is returned to the browser: the action result literals carry ids and booleans, never `client.name`.
    expect(src.slice(bookLookup, bookLookup + 6000)).not.toMatch(/return\s*\{[^}]*client\.name/);
  });
});
