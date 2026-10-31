import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-48 F1 (held for Sam's rule). This file was BLOCK-SCOPE R1's pin of the
// old write scope (every calendar drag-to-block inserted a studio-wide row).
// It is inverted here on purpose:
//   * capacity OFF: the owner's insert is unchanged (no practitioner_id, the
//     0137/0138 guard refuses a scoped row there); a non-owner is refused, since
//     0253 makes a studio-wide block owner-only (decision 14);
//   * capacity ON, non-owner: practitioner_id = the caller, server-derived; a
//     submitted scope can neither widen it to the studio nor point it at a
//     colleague;
//   * capacity ON, owner: an explicit choice is required; "all" keeps the
//     pre-F1 studio-wide insert, an id scopes the block to that practitioner.

const state = vi.hoisted(() => ({
  capacity: true,
  role: "practitioner" as "practitioner" | "owner",
  insertError: null as null | { code: string; message: string },
  insert: vi.fn(),
  from: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "p-actor", active: true, role: state.role },
    studio: { id: "s-1", timezone: "America/Los_Angeles", practitioner_capacity_enabled: state.capacity },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      state.from(table);
      return {
        insert: async (row: Record<string, unknown>) => {
          state.insert(row);
          return { error: state.insertError };
        },
      };
    },
  }),
}));

import { createCalendarTimedBlockAction } from "@/app/(app)/calendar/calendar-block-actions";

const BASE = {
  studio_id: "s-1",
  starts_at: "2031-05-12T19:00:00.000Z",
  ends_at: "2031-05-12T20:00:00.000Z",
  category: "other",
  private_note: "synthetic lunch",
  created_by: "p-actor",
};

function form(scope?: string): FormData {
  const fd = new FormData();
  fd.set("date", "2031-05-12");
  fd.set("start_local", "12:00");
  fd.set("end_local", "13:00");
  fd.set("reason", "synthetic lunch");
  if (scope !== undefined) fd.set("block_scope", scope);
  return fd;
}

function inserted(): Record<string, unknown> {
  expect(state.from).toHaveBeenCalledWith("studio_timed_blocks");
  expect(state.insert).toHaveBeenCalledTimes(1);
  return state.insert.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  state.insert.mockClear();
  state.from.mockClear();
  state.insertError = null;
});

describe("capacity OFF: the owner's unchanged studio-wide insert; a non-owner is refused (0253, decision 14)", () => {
  for (const scope of [undefined, "all", "p-other"]) {
    it(`owner, scope ${scope ?? "absent"}: no practitioner_id`, async () => {
      state.capacity = false;
      state.role = "owner";
      await expect(createCalendarTimedBlockAction(form(scope))).resolves.toEqual({ ok: true });
      const row = inserted();
      expect(row).not.toHaveProperty("practitioner_id");
      expect(row).toEqual(BASE);
    });
    it(`practitioner, scope ${scope ?? "absent"}: refused with the owner-only copy, nothing written`, async () => {
      state.capacity = false;
      state.role = "practitioner";
      await expect(createCalendarTimedBlockAction(form(scope))).resolves.toEqual({
        ok: false,
        error: "Only the studio owner can block time for the whole studio. Ask the owner to add this block.",
      });
      expect(state.insert).not.toHaveBeenCalled();
    });
  }
});

describe("capacity ON, non-owner: own time only", () => {
  for (const scope of [undefined, "all", "p-other", ""]) {
    it(`scope ${JSON.stringify(scope ?? null)}: practitioner_id = self`, async () => {
      state.capacity = true;
      state.role = "practitioner";
      await expect(createCalendarTimedBlockAction(form(scope))).resolves.toEqual({ ok: true });
      expect(inserted()).toEqual({ ...BASE, practitioner_id: "p-actor" });
    });
  }

  it("a row-security refusal (member policy not yet widened) is a plain message, never the DB text", async () => {
    state.capacity = true;
    state.role = "practitioner";
    state.insertError = { code: "42501", message: "new row violates row-level security policy for table" };
    const r = await createCalendarTimedBlockAction(form());
    expect(r).toEqual({ ok: false, error: "This block could not be saved for you only. Ask the studio owner to add it." });
  });
});

describe("capacity ON, owner: explicit choice", () => {
  it("no choice is refused before any insert", async () => {
    state.capacity = true;
    state.role = "owner";
    for (const scope of [undefined, "", "  "]) {
      await expect(createCalendarTimedBlockAction(form(scope))).resolves.toEqual({
        ok: false,
        error: "Choose who this block applies to.",
      });
    }
    expect(state.insert).not.toHaveBeenCalled();
  });

  it('"all" keeps the exact pre-F1 studio-wide insert', async () => {
    state.capacity = true;
    state.role = "owner";
    await expect(createCalendarTimedBlockAction(form("all"))).resolves.toEqual({ ok: true });
    const row = inserted();
    expect(row).not.toHaveProperty("practitioner_id");
    expect(row).toEqual(BASE);
  });

  it("a practitioner id scopes the block to that practitioner (self or a colleague)", async () => {
    state.capacity = true;
    state.role = "owner";
    await createCalendarTimedBlockAction(form("p-di"));
    expect(inserted()).toEqual({ ...BASE, practitioner_id: "p-di" });
    state.insert.mockClear();
    await createCalendarTimedBlockAction(form("p-actor"));
    expect(inserted()).toEqual({ ...BASE, practitioner_id: "p-actor" });
  });

  it("database scope refusals map to owner copy, never the DB text", async () => {
    state.capacity = true;
    state.role = "owner";
    const cases: Array<[string, string]> = [
      ["23514", "That practitioner is no longer active. Choose an active practitioner, or make this block apply to all practitioners."],
      ["23503", "That practitioner does not belong to this studio."],
      ["42501", "Per-practitioner scheduling is not enabled for this studio, so this block must apply to all practitioners."],
    ];
    for (const [code, error] of cases) {
      state.insertError = { code, message: "raw db text" };
      await expect(createCalendarTimedBlockAction(form("p-di"))).resolves.toEqual({ ok: false, error });
    }
  });

  it("an overlap stays the existing 23P01 message", async () => {
    state.capacity = true;
    state.role = "owner";
    state.insertError = { code: "23P01", message: "conflicting key value" };
    await expect(createCalendarTimedBlockAction(form("p-di"))).resolves.toEqual({
      ok: false,
      error: "That time overlaps an existing block or appointment.",
    });
  });
});
