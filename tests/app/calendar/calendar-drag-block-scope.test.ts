import { beforeEach, describe, expect, it, vi } from "vitest";

// BLOCK-SCOPE R1 (Photos' recipe, photos/BLOCK-SCOPE-END.json). This PINS the
// CURRENT write scope of calendar drag-to-block: the insert carries NO
// practitioner_id, so the row is studio-wide (NULL), whatever the capacity mode
// or who drags. Under practitioner capacity that closes the time for every
// practitioner (0137 fans a NULL row out to one reservation each).
//
// That behaviour is held, not endorsed: whether a practitioner's own block
// should be scoped to them under capacity ON (F1) waits for Sam's product rule.
// When that rule lands, this test is meant to fail and be inverted on purpose
// (capacity ON: toMatchObject({ practitioner_id: <actor> }); capacity OFF: still
// no practitioner_id, since the 0137/0138 guard refuses a scoped row there).

const state = vi.hoisted(() => ({
  capacity: true,
  role: "practitioner" as "practitioner" | "owner",
  insert: vi.fn<(row: Record<string, unknown>) => Promise<{ error: null }>>(async () => ({ error: null })),
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
      return { insert: state.insert };
    },
  }),
}));

import { createCalendarTimedBlockAction } from "@/app/(app)/calendar/calendar-block-actions";

function form(): FormData {
  const fd = new FormData();
  fd.set("date", "2031-05-12");
  fd.set("start_local", "12:00");
  fd.set("end_local", "13:00");
  fd.set("reason", "synthetic lunch");
  return fd;
}

beforeEach(() => {
  state.insert.mockClear();
  state.from.mockClear();
});

describe("calendar drag-to-block write scope (pinned, F1 held)", () => {
  for (const capacity of [true, false]) {
    for (const role of ["practitioner", "owner"] as const) {
      it(`capacity ${capacity ? "ON" : "OFF"}, ${role}: inserts a studio-wide row (no practitioner_id)`, async () => {
        state.capacity = capacity;
        state.role = role;
        await expect(createCalendarTimedBlockAction(form())).resolves.toEqual({ ok: true });
        expect(state.from).toHaveBeenCalledWith("studio_timed_blocks");
        expect(state.insert).toHaveBeenCalledTimes(1);
        const row = state.insert.mock.calls[0][0];
        expect(row).not.toHaveProperty("practitioner_id");
        expect(row).toEqual({
          studio_id: "s-1",
          starts_at: "2031-05-12T19:00:00.000Z",
          ends_at: "2031-05-12T20:00:00.000Z",
          category: "other",
          private_note: "synthetic lunch",
          created_by: "p-actor",
        });
      });
    }
  }

  it("the action source has no practitioner_id in its insert", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.resolve(__dirname, "../../../app/(app)/calendar/calendar-block-actions.ts"), "utf8");
    expect(src).not.toMatch(/practitioner_id/);
  });
});
