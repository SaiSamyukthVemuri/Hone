import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createBookingSupabaseMock,
  filterValue,
  type Query,
  type RecordedRpc,
} from "./helpers/booking-supabase-mock";

// SMART SUGGESTIONS ARE NOT AVAILABILITY — behavioural proof.
//
// Chloe's report: smart scheduling suggests 3:10; she deliberately wants 3:30;
// 3:30 is inside her working hours and conflict-free; Hone told her the time
// was unavailable and offered only a control saying she was booking OUTSIDE her
// availability. Both statements were false, and taking that route recorded the
// booking as an out-of-hours exception forever (booked_outside_availability,
// an audit stamp, an authorising owner, and the buffer trigger disabled for
// that row).
//
// THE FIXTURE, which is the one that reproduces her exact numbers:
//   studio 09:00-17:00 local, buffer 30, service 60 minutes,
//   one existing appointment 13:40-14:40 (protected end 15:10 with the buffer).
//
// The packed suggestion set for that day is
//   9:00 | 10:00 | 11:00 | 12:00 | 12:10 | 3:10 PM | 4:00
// so 15:10 IS suggested and 15:30 is NOT — while 15:30 is inside the window
// (15:30 + 60 = 16:30 <= 17:00) and does not touch [13:40, 15:10).
//
// These tests drive the real server action. Filters are RECORDED rather than
// discarded, so "the target's own hours were used" is a claim the harness can
// actually falsify.

const TZ = "America/Toronto";
const DATE = "2099-07-06"; // Monday, EDT (UTC-4), far future so past-time passes
const Z = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const utcH = h + 4; // EDT
  return `${DATE}T${String(utcH).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
};

const SUGGESTED = Z("15:10");
const MANUAL_INSIDE = Z("15:30"); // inside hours, conflict-free, NOT suggested
const MANUAL_BOUNDARY = Z("16:00"); // 16:00 + 60 = 17:00, exactly on close
const OUTSIDE_LATE = Z("16:30"); // 16:30 + 60 = 17:30 > close
const OUTSIDE_EARLY = Z("08:30"); // before open
const OVERLAPPING = Z("13:30"); // 13:30-14:30 collides with 13:40-14:40

const OWNER = "prac-owner";
const MEMBER = "prac-member";
const OTHER = "prac-other";

// Mutable scenario the mocks read. Everything is per-test.
const scenario = {
  role: "owner" as string,
  active: true,
  capacityOn: false,
  // capacity-ON per-practitioner windows, keyed by practitioner id.
  practitionerWindows: {} as Record<
    string,
    { is_open: boolean; open_time: string; close_time: string } | null
  >,
  studioWideWindow: {
    is_open: true,
    open_time: "09:00:00",
    close_time: "17:00:00",
  } as { is_open: boolean; open_time: string; close_time: string } | null,
  blockouts: [] as { starts_on: string; ends_on: string }[],
  // When set, the blockout read reports this error instead of rows.
  blockoutError: null as { code: string } | null,
  rpcResult: "created" as string,
  // When set, the RPC reports this Postgres error instead of a result row
  // (23P01 = the per-resource exclusion firing).
  rpcError: null as { code: string } | null,
};

const rpcCalls: RecordedRpc[] = [];
let mock: ReturnType<typeof createBookingSupabaseMock>;

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: {
      id: scenario.role === "owner" ? OWNER : MEMBER,
      role: scenario.role,
      active: scenario.active,
      display_name: "P",
      email: "p@example.com",
    },
    studio: {
      id: "studio-1",
      timezone: TZ,
      default_appointment_duration_minutes: 60,
      buffer_minutes: 30,
      practitioner_capacity_enabled: scenario.capacityOn,
      name: "S",
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mock.client,
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (scenario.rpcError) return { data: null, error: scenario.rpcError };
      return {
        data: [
          {
            result: scenario.rpcResult,
            appointment_id:
              scenario.rpcResult === "created" ? "appt-1" : null,
            starts_at: null,
            ends_at: null,
          },
        ],
        error: null,
      };
    },
  }),
}));

// revalidatePath needs a Next request store; the booking path calls it only
// AFTER the command succeeds, which is past everything under test here.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { bookAppointmentForClientAction } from "@/app/(app)/calendar/actions";

function resolver(q: Query) {
  switch (q.table) {
    case "services":
      return {
        data: {
          id: "svc-1",
          studio_id: "studio-1",
          active: true,
          default_duration_minutes: 60,
        },
        error: null,
      };
    case "clients":
      return {
        data: { id: "c1", name: "C", email: null, phone: null },
        error: null,
      };
    case "appointments":
      // The post-commit follow-up read. Returning null takes the documented
      // "committed but follow-up read failed" branch, which skips the email
      // dispatch without affecting anything under test.
      return { data: null, error: null };
    case "studio_blockouts":
      return scenario.blockoutError
        ? { data: null, error: scenario.blockoutError }
        : { data: scenario.blockouts, error: null };
    case "studio_availability_overrides":
      // No date overrides in any of these fixtures.
      return { data: null, error: null };
    case "studio_availability_default": {
      // PREDICATE-SENSITIVE. A practitioner-scoped read (`eq practitioner_id`)
      // must resolve that practitioner's own row; the studio-wide read
      // (`is practitioner_id null`) must resolve the studio-wide row. If the
      // action queried the wrong practitioner, these differ and the test fails.
      const scoped = filterValue(q, "eq", "practitioner_id");
      if (typeof scoped === "string") {
        return { data: scenario.practitionerWindows[scoped] ?? null, error: null };
      }
      return { data: scenario.studioWideWindow, error: null };
    }
    default:
      return { data: null, error: null };
  }
}

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

const book = (extra: Record<string, string>) =>
  bookAppointmentForClientAction(
    fd({ client_id: "c1", service_id: "svc-1", ...extra }),
  );

const lastRpc = () => rpcCalls[rpcCalls.length - 1];

beforeEach(() => {
  scenario.role = "owner";
  scenario.active = true;
  scenario.capacityOn = false;
  scenario.practitionerWindows = {};
  scenario.studioWideWindow = {
    is_open: true,
    open_time: "09:00:00",
    close_time: "17:00:00",
  };
  scenario.blockouts = [];
  scenario.blockoutError = null;
  scenario.rpcResult = "created";
  scenario.rpcError = null;
  rpcCalls.length = 0;
  mock = createBookingSupabaseMock(resolver);
});

// ---------------------------------------------------------------------------
// A + B — the report itself
// ---------------------------------------------------------------------------

describe("A — a smart-suggested time books normally", () => {
  it("15:10 (a packed suggestion) reaches the command with the flag FALSE", async () => {
    const r = await book({ starts_at: SUGGESTED });
    expect(r.ok).toBe(true);
    expect(lastRpc().fn).toBe("create_internal_appointment_v2");
    expect(lastRpc().args.p_allow_outside_availability).toBe(false);
  });
});

describe("B — a manual time inside working hours books normally", () => {
  it("15:30 is accepted even though it is NOT one of the suggestions", async () => {
    const r = await book({ starts_at: MANUAL_INSIDE });
    expect(r.ok).toBe(true);
  });

  it("15:30 is booked with allow_outside_availability FALSE", async () => {
    await book({ starts_at: MANUAL_INSIDE });
    // The whole point. TRUE here would persist booked_outside_availability on
    // the row, stamp an authorising owner into the audit record, and disable
    // the buffer trigger for an ordinary working-hours appointment.
    expect(lastRpc().args.p_allow_outside_availability).toBe(false);
  });

  it("15:30 is not merely accepted — the OLD suggestion-membership refusal is gone", async () => {
    // The exact string the practitioner used to be shown for a perfectly legal
    // time. If suggestion membership ever creeps back in as the gate, this is
    // what would come back.
    const r = await book({ starts_at: MANUAL_INSIDE });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/no longer available/i);
  });

  it("a manual time landing exactly on close (16:00 + 60 = 17:00) is INSIDE", async () => {
    // The window is measured on the SERVICE end, matching the SQL validator and
    // the slot engine; the trailing buffer may spill past close.
    const r = await book({ starts_at: MANUAL_BOUNDARY });
    expect(r.ok).toBe(true);
    expect(lastRpc().args.p_allow_outside_availability).toBe(false);
  });

  it("a MEMBER (non-owner) can book a manual inside-hours time", async () => {
    // Manual-inside-hours is an ordinary booking, so it is not owner-gated.
    scenario.role = "practitioner";
    const r = await book({ starts_at: MANUAL_INSIDE });
    expect(r.ok).toBe(true);
    expect(lastRpc().args.p_allow_outside_availability).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C + D + E — the genuine outside-hours path is untouched
// ---------------------------------------------------------------------------

describe("C — a genuinely outside-hours time without the override is refused", () => {
  it("16:30 (service would end 17:30, past close) is refused", async () => {
    const r = await book({ starts_at: OUTSIDE_LATE });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/outside the practitioner's availability/i);
    expect(rpcCalls).toHaveLength(0);
  });

  it("08:30 (before open) is refused", async () => {
    const r = await book({ starts_at: OUTSIDE_EARLY });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/outside the practitioner's availability/i);
    expect(rpcCalls).toHaveLength(0);
  });

  it("a CLOSED day is refused with the closed reason, not the outside-hours one", async () => {
    scenario.studioWideWindow = {
      is_open: false,
      open_time: "09:00:00",
      close_time: "17:00:00",
    };
    const r = await book({ starts_at: MANUAL_INSIDE });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/isn't working at that time/i);
    expect(rpcCalls).toHaveLength(0);
  });

  it("a day with NO availability row at all is refused (fail closed)", async () => {
    scenario.studioWideWindow = null;
    const r = await book({ starts_at: MANUAL_INSIDE });
    expect(r.ok).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("D — an authorized owner override still succeeds", () => {
  it("16:30 WITH the override reaches the command with the flag TRUE", async () => {
    const r = await book({
      starts_at: OUTSIDE_LATE,
      allow_outside_availability: "true",
    });
    expect(r.ok).toBe(true);
    expect(lastRpc().args.p_allow_outside_availability).toBe(true);
  });

  it("the override still skips the working-hours check entirely", async () => {
    await book({
      starts_at: OUTSIDE_EARLY,
      allow_outside_availability: "true",
    });
    expect(rpcCalls).toHaveLength(1);
  });
});

describe("E — a non-owner cannot forge the outside override", () => {
  it("a member sending allow_outside_availability=true is refused", async () => {
    scenario.role = "practitioner";
    const r = await book({
      starts_at: OUTSIDE_LATE,
      allow_outside_availability: "true",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/only the studio owner can book outside/i);
    expect(rpcCalls).toHaveLength(0);
  });

  it("a member cannot forge it for an INSIDE-hours time either", async () => {
    // The gate is on the flag, unconditionally — it is never softened by the
    // fact that the time happens to be legal.
    scenario.role = "practitioner";
    const r = await book({
      starts_at: MANUAL_INSIDE,
      allow_outside_availability: "true",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/only the studio owner can book outside/i);
    expect(rpcCalls).toHaveLength(0);
  });

  it("a member cannot attach a custom duration to a manual inside-hours time", async () => {
    // A caller-supplied length is owner-only in the DB command and is coupled to
    // the override; this PR deliberately does not widen that.
    scenario.role = "practitioner";
    const r = await book({
      starts_at: MANUAL_INSIDE,
      duration_minutes_override: "45",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/custom duration requires the outside-availability override/i);
    expect(rpcCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F + G + H — real conflicts still refuse a manual inside-hours time
// ---------------------------------------------------------------------------

describe("F/H — collisions and buffer remain authoritative for a manual time", () => {
  it("an overlapping manual time REACHES the DB and is refused as 'slot taken'", async () => {
    // The app layer no longer pre-filters overlap; the per-resource GiST
    // exclusion on studio_calendar_reservations is the authority and cannot be
    // bypassed by anyone, including the override. Driven here through the real
    // 23P01 mapping in the action.
    scenario.rpcError = { code: "23P01" };
    const r = await book({ starts_at: OVERLAPPING });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("slot_taken");
    // Crucially it must NOT be refused as an availability problem: 13:30 IS
    // inside working hours, and calling a collision an availability violation is
    // the same class of lie this PR exists to remove.
    expect(!r.ok && r.error).not.toMatch(/outside the practitioner's availability/i);
    // It reached the command, which is where the authority lives.
    expect(rpcCalls).toHaveLength(1);
    expect(lastRpc().args.p_allow_outside_availability).toBe(false);
  });

  it("a buffer-conflicting manual time is refused with the buffer reason", async () => {
    scenario.rpcResult = "buffer_conflict";
    const r = await book({ starts_at: MANUAL_INSIDE });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/within the buffer around another appointment/i);
  });
});

describe("G — blockouts and closed days refuse a manual time", () => {
  it("a full-day blockout refuses the manual time before the command runs", async () => {
    scenario.blockouts = [{ starts_on: DATE, ends_on: DATE }];
    const r = await book({ starts_at: MANUAL_INSIDE });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/isn't working at that time/i);
    expect(rpcCalls).toHaveLength(0);
  });

  it("an UNREADABLE blockout table fails CLOSED, never as 'no time off'", async () => {
    // The manual-time path is the only working-hours authority a capacity-OFF
    // studio has, so "we could not tell whether she is off today" must resolve
    // to no. Reading a failed query as an empty result would book a client onto
    // a day the practitioner deliberately took off.
    //
    // This is deliberately STRICTER than slot generation, which has always
    // discarded this error and continues; that behaviour reaches the public
    // booking page and is preserved there rather than changed as a side effect.
    scenario.blockoutError = { code: "PGRST301" };
    const r = await book({ starts_at: MANUAL_INSIDE });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/isn't working at that time/i);
    expect(rpcCalls).toHaveLength(0);
  });

  it("a timed block / recurring break is left to the DB collision authority", async () => {
    // Those live in studio_calendar_reservations and are enforced by the same
    // per-resource exclusion as appointments, in BOTH capacity modes. The app
    // layer deliberately does not re-implement them.
    scenario.rpcResult = "created";
    const r = await book({ starts_at: MANUAL_INSIDE });
    expect(r.ok).toBe(true);
    expect(lastRpc().args.p_allow_outside_availability).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I + J + K + L — the window is resolved for the RIGHT practitioner and length
// ---------------------------------------------------------------------------

describe("I — capacity ON respects the TARGET practitioner's own hours", () => {
  beforeEach(() => {
    scenario.capacityOn = true;
    scenario.role = "owner";
  });

  it("uses the target's window, not the studio-wide one", async () => {
    // Target works 09:00-17:00 (15:30 inside). Studio-wide says 09:00-12:00.
    scenario.practitionerWindows[OTHER] = {
      is_open: true,
      open_time: "09:00:00",
      close_time: "17:00:00",
    };
    scenario.studioWideWindow = {
      is_open: true,
      open_time: "09:00:00",
      close_time: "12:00:00",
    };
    const r = await book({ starts_at: MANUAL_INSIDE, practitioner_id: OTHER });
    expect(r.ok).toBe(true);
    expect(lastRpc().args.p_target_practitioner_id).toBe(OTHER);
    expect(lastRpc().args.p_allow_outside_availability).toBe(false);
    // Proof the resolution was actually target-scoped rather than incidental:
    // a practitioner-scoped availability read was issued for THIS target.
    const scoped = mock
      .queriesFor("studio_availability_default")
      .some((q) => filterValue(q, "eq", "practitioner_id") === OTHER);
    expect(scoped).toBe(true);
  });

  it("a time outside the TARGET's shorter window is refused even if studio-wide allows it", async () => {
    // Target finishes at 12:00; the studio is open until 17:00. 15:30 must be
    // refused: A's hours can never authorise a booking on B.
    scenario.practitionerWindows[OTHER] = {
      is_open: true,
      open_time: "09:00:00",
      close_time: "12:00:00",
    };
    scenario.studioWideWindow = {
      is_open: true,
      open_time: "09:00:00",
      close_time: "17:00:00",
    };
    const r = await book({ starts_at: MANUAL_INSIDE, practitioner_id: OTHER });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/outside the practitioner's availability/i);
    expect(rpcCalls).toHaveLength(0);
  });

  it("falls back to the studio-wide window when the target has no row of their own", async () => {
    scenario.practitionerWindows = {}; // no per-practitioner row
    scenario.studioWideWindow = {
      is_open: true,
      open_time: "09:00:00",
      close_time: "17:00:00",
    };
    const r = await book({ starts_at: MANUAL_INSIDE, practitioner_id: OTHER });
    expect(r.ok).toBe(true);
  });
});

describe("J — Legacy / capacity OFF respects the studio-wide hours", () => {
  it("refuses a time outside the studio-wide window", async () => {
    scenario.capacityOn = false;
    scenario.studioWideWindow = {
      is_open: true,
      open_time: "09:00:00",
      close_time: "12:00:00",
    };
    const r = await book({ starts_at: MANUAL_INSIDE });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/outside the practitioner's availability/i);
    expect(rpcCalls).toHaveLength(0);
  });

  it("reads the STUDIO-WIDE row, never a retained per-practitioner one", async () => {
    scenario.capacityOn = false;
    await book({ starts_at: MANUAL_INSIDE });
    const reads = mock.queriesFor("studio_availability_default");
    expect(reads.length).toBeGreaterThan(0);
    // Every default read on the OFF path must scope practitioner_id IS NULL.
    for (const q of reads) {
      expect(q.filters.some((f) => f.op === "is" && f.column === "practitioner_id")).toBe(true);
    }
  });

  it("THE REASON THIS CHECK EXISTS: capacity OFF gets no hours enforcement from the DB", async () => {
    // validate_appointment_availability fences its entire working-hours block
    // behind `if v_cap then` (migration 0152), so with capacity OFF Postgres
    // would accept 08:30 happily. This assertion pins that the refusal came
    // from the application layer, BEFORE the command was ever called.
    scenario.capacityOn = false;
    const r = await book({ starts_at: OUTSIDE_EARLY });
    expect(r.ok).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("K + L — the manual time is revalidated against the CURRENT target and length", () => {
  it("K: switching practitioner re-resolves the window and can flip the verdict", async () => {
    scenario.capacityOn = true;
    scenario.practitionerWindows[OWNER] = {
      is_open: true,
      open_time: "09:00:00",
      close_time: "17:00:00",
    };
    scenario.practitionerWindows[OTHER] = {
      is_open: true,
      open_time: "09:00:00",
      close_time: "12:00:00",
    };
    const forOwner = await book({
      starts_at: MANUAL_INSIDE,
      practitioner_id: OWNER,
    });
    expect(forOwner.ok).toBe(true);

    rpcCalls.length = 0;
    mock = createBookingSupabaseMock(resolver);
    const forOther = await book({
      starts_at: MANUAL_INSIDE,
      practitioner_id: OTHER,
    });
    expect(forOther.ok).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });

  it("L: the window is measured against the SERVICE duration the command will use", async () => {
    // 16:30 fits a 30-minute service (ends 17:00) but not a 60-minute one
    // (ends 17:30). The check must use the service's authoritative length, which
    // is what create_internal_appointment_v2 derives from the locked row.
    const r60 = await book({ starts_at: OUTSIDE_LATE });
    expect(r60.ok).toBe(false);

    rpcCalls.length = 0;
    mock = createBookingSupabaseMock((q) =>
      q.table === "services"
        ? {
            data: {
              id: "svc-1",
              studio_id: "studio-1",
              active: true,
              default_duration_minutes: 30,
            },
            error: null,
          }
        : resolver(q),
    );
    const r30 = await book({ starts_at: OUTSIDE_LATE });
    expect(r30.ok).toBe(true);
    expect(lastRpc().args.p_allow_outside_availability).toBe(false);
  });
});
