import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A failed drag-to-block insert must never hand the database's own text to the
// UI or to a log line. Photos F3: the action used to return
// `Failed to add block: ${error.message}`. That text can quote a value, an
// address or a constraint name. The UI gets one fixed sentence per known SQLSTATE
// and a generic one otherwise; the log gets the closed code only.
// Synthetic hostile text only.

const HOSTILE = {
  address: "88 Fakeville Road, Unit 4",
  phone: "+1 555 010 0199",
  constraint: "studio_timed_blocks_no_overlap_excl_secret_idx",
  email: "synthetic.person@example.invalid",
};
const HOSTILE_VALUES = Object.values(HOSTILE);
const hostileText = `Key (private_note)=(call ${HOSTILE.phone} at ${HOSTILE.address}) conflicts with ${HOSTILE.constraint} for ${HOSTILE.email}`;

const state = vi.hoisted(() => ({
  insertError: null as null | Record<string, unknown>,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "p-actor", active: true, role: "owner" },
    studio: { id: "s-1", timezone: "America/Los_Angeles", practitioner_capacity_enabled: false },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ insert: async () => ({ error: state.insertError }) }),
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

const OVERLAP = "That time overlaps an existing block or appointment.";
const EXPECT: Record<string, string> = {
  "23P01": OVERLAP,
  "42501": "You do not have permission to add this block.",
  "23503": "That practitioner or studio is no longer available. Refresh the calendar and try again.",
  "23514": "That block is not allowed for this studio. Refresh the calendar and try again.",
  "22007": "That block could not be saved. Check the date, times and reason, then try again.",
  "22008": "That block could not be saved. Check the date, times and reason, then try again.",
  "22P02": "That block could not be saved. Check the date, times and reason, then try again.",
  "22001": "That block could not be saved. Check the date, times and reason, then try again.",
  "23502": "That block could not be saved. Check the date, times and reason, then try again.",
  "55P03": "The calendar is busy right now. Try again in a moment.",
  "57014": "The calendar is busy right now. Try again in a moment.",
  "40001": "The calendar is busy right now. Try again in a moment.",
  "40P01": "The calendar is busy right now. Try again in a moment.",
};
const GENERIC = "We could not add that block. Try again in a moment.";

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
});
afterEach(() => vi.restoreAllMocks());

const leaks = (s: string) => HOSTILE_VALUES.filter((v) => s.includes(v));

describe("a failed block insert never carries the database's text", () => {
  for (const [code, sentence] of Object.entries(EXPECT)) {
    it(`${code}: the fixed sentence, none of the hostile text, a code-only log`, async () => {
      state.insertError = { code, message: hostileText, details: hostileText, hint: hostileText };
      const r = await createCalendarTimedBlockAction(form());
      expect(r).toEqual({ ok: false, error: sentence });
      expect(leaks(JSON.stringify(r))).toEqual([]);
      expect(leaks(logged.join("\n"))).toEqual([]);
      if (code !== "23P01") {
        expect(logged).toHaveLength(1);
        expect(JSON.parse(logged[0])).toMatchObject({ event: "calendar_timed_block_insert_failed", code });
      }
    });
  }

  for (const code of [undefined, "XX000", "P0001", "PGRST116", "not a code", `${HOSTILE.constraint}`]) {
    it(`unknown code ${JSON.stringify(code ?? null)}: the generic sentence and no leak`, async () => {
      state.insertError = { code, message: hostileText, details: hostileText, hint: hostileText };
      const r = await createCalendarTimedBlockAction(form());
      expect(r).toEqual({ ok: false, error: GENERIC });
      expect(leaks(JSON.stringify(r))).toEqual([]);
      expect(leaks(logged.join("\n"))).toEqual([]);
      // a code that is not exactly a SQLSTATE or PostgREST code is logged as "unknown"
      const line = JSON.parse(logged[0]);
      expect(["XX000", "P0001", "PGRST116", "unknown"]).toContain(line.code);
      expect(line.code).not.toContain(HOSTILE.constraint);
    });
  }

  it("the source never interpolates error.message, details or hint", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../../app/(app)/calendar/calendar-block-actions.ts"), "utf8",
    ).replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/error\.message|error\.details|error\.hint|\.message\b/);
  });
});
