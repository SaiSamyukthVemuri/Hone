import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// WAIT-04A — manual entry, legacy import, and stated availability
// ===========================================================================
//
// THESE PROVE THE SEAM, NOT THE RULE. Owner re-derivation, the provenance
// CHECK, the one-active-per-email index and the refusal vocabulary all belong
// to migration 0193 and are proved in the DB suites. What can go wrong HERE is
// the wiring: calling the wrong command, trusting a browser-supplied tenant,
// reading a refusal as a success, writing a table directly, inventing a default
// the person never gave, or putting an internal code in front of a practitioner.
//
// All three commands shipped in 0193 with ZERO application callers. That is the
// defect this slice closes, and it is the reason these tests assert the ARGUMENT
// SHAPE as hard as the outcome: nothing has ever exercised these call sites.

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { revalidatePath } from "next/cache";
import {
  addWaitlistEntryAction,
  importLegacyWaitlistEntryAction,
  setWaitlistAvailabilityAction,
} from "@/app/(app)/settings/waitlist/profile-actions";
import { studioLocalDateInstant } from "@/lib/waitlist/studio-local-date";
import { localDateString, localTimeString } from "@/lib/booking/tz";

const STUDIO = "11111111-1111-1111-1111-111111111111";
const ACTOR = "22222222-2222-2222-2222-222222222222";
const ENTRY = "33333333-3333-3333-3333-333333333333";
const FOREIGN_STUDIO = "99999999-9999-9999-9999-999999999999";

type RpcCall = { name: string; args: Record<string, unknown> };
let calls: RpcCall[] = [];
let tableTouches: string[] = [];
let errors: string[] = [];

function arrangeRpc(reply: { data?: unknown; error?: { code?: string } | null }) {
  vi.mocked(createAdminClient).mockReturnValue({
    // A DIRECT TABLE WRITE IS A FAILURE, NOT A FALLBACK. 0185 grants
    // `authenticated` SELECT and nothing else, and 0193 grants column-SELECT
    // only, so anything reaching here is a design error rather than something
    // to answer.
    from: (table: string) => {
      tableTouches.push(table);
      throw new Error(`the waitlist profile action must not touch tables directly: ${table}`);
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null });
    },
  } as unknown as ReturnType<typeof createAdminClient>);
}

function arrangeActor(
  role: "owner" | "member" = "owner",
  userId: string | null = ACTOR,
  timezone: string | null = "America/Toronto",
) {
  vi.mocked(getCurrentPractitionerWithStudio).mockResolvedValue({
    practitioner: { role, user_id: userId },
    studio: { id: STUDIO, timezone },
  } as unknown as Awaited<ReturnType<typeof getCurrentPractitionerWithStudio>>);
}

/** `returns table (result, entry_id)` arrives as an array of rows. */
function rows(result: string) {
  return [{ result, entry_id: ENTRY }];
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  calls = [];
  tableTouches = [];
  errors = [];
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
  arrangeActor();
});

// ---------------------------------------------------------------------------

describe("stated availability", () => {
  it("calls 0193's command with a SERVER-DERIVED tenant and actor", async () => {
    arrangeRpc({ data: "stated" });
    const res = await setWaitlistAvailabilityAction(
      form({ entry_id: ENTRY, preference: "weekends" }),
    );

    expect(res).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        name: "set_waitlist_entry_availability",
        args: {
          p_studio_id: STUDIO,
          p_entry_id: ENTRY,
          p_actor_user_id: ACTOR,
          p_preference: "weekends",
        },
      },
    ]);
    expect(tableTouches).toEqual([]);
    expect(revalidatePath).toHaveBeenCalledWith("/settings/waitlist");
  });

  it("IGNORES a browser-supplied studio or actor", async () => {
    // The form can name anything; only the session decides the tenant.
    arrangeRpc({ data: "stated" });
    await setWaitlistAvailabilityAction(
      form({
        entry_id: ENTRY,
        preference: "weekdays",
        studio_id: FOREIGN_STUDIO,
        p_studio_id: FOREIGN_STUDIO,
        actor_user_id: FOREIGN_STUDIO,
      }),
    );
    expect(calls[0].args.p_studio_id).toBe(STUDIO);
    expect(calls[0].args.p_actor_user_id).toBe(ACTOR);
    expect(JSON.stringify(calls[0].args)).not.toContain(FOREIGN_STUDIO);
  });

  it("treats all THREE success codes as recorded", async () => {
    // `stated`, `changed` and `confirmed` are different facts in the two
    // timestamp columns, and all three mean the write happened. Reading only
    // one as success would report a re-confirmation as a failure.
    for (const code of ["stated", "changed", "confirmed"]) {
      arrangeRpc({ data: code });
      const res = await setWaitlistAvailabilityAction(
        form({ entry_id: ENTRY, preference: "both" }),
      );
      expect(res, `code ${code}`).toEqual({ ok: true });
    }
  });

  it("refuses a preference outside the three, WITHOUT calling the command", async () => {
    arrangeRpc({ data: "stated" });
    const res = await setWaitlistAvailabilityAction(
      form({ entry_id: ENTRY, preference: "alternate tuesdays" }),
    );
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses an EMPTY preference rather than defaulting one", async () => {
    // The select's placeholder submits "". Writing a default here would record
    // an answer the person never gave.
    arrangeRpc({ data: "stated" });
    const res = await setWaitlistAvailabilityAction(form({ entry_id: ENTRY, preference: "" }));
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a member is refused before the command is reached", async () => {
    arrangeActor("member");
    arrangeRpc({ data: "stated" });
    const res = await setWaitlistAvailabilityAction(
      form({ entry_id: ENTRY, preference: "both" }),
    );
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("puts NO internal code in front of a practitioner", async () => {
    for (const code of ["entry_not_found", "entry_closed", "not_owner", "invalid_input"]) {
      arrangeRpc({ data: code });
      const res = await setWaitlistAvailabilityAction(
        form({ entry_id: ENTRY, preference: "both" }),
      );
      expect(res.ok, `code ${code}`).toBe(false);
      if (!res.ok) {
        expect(res.message, `code ${code} leaked`).not.toContain(code);
        expect(res.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("an unrecognised code is still a refusal, not a success", async () => {
    arrangeRpc({ data: "some_future_code" });
    const res = await setWaitlistAvailabilityAction(
      form({ entry_id: ENTRY, preference: "both" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).not.toContain("some_future_code");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("manual entry", () => {
  it("calls 0193's command and CANNOT supply a joined_at", async () => {
    // The command owns the date. Someone the studio adds now joined now, and
    // there is no parameter through which this form could say otherwise.
    arrangeRpc({ data: rows("created") });
    const res = await addWaitlistEntryAction(
      form({ name: "Jo Smith", email: "jo@example.com", phone: "555 0100", preference: "weekdays" }),
    );

    expect(res).toEqual({ ok: true });
    expect(calls[0].name).toBe("create_practitioner_waitlist_entry");
    expect(calls[0].args).toEqual({
      p_studio_id: STUDIO,
      p_actor_user_id: ACTOR,
      p_name: "Jo Smith",
      p_email: "jo@example.com",
      p_phone: "555 0100",
      p_preference: "weekdays",
    });
    expect(Object.keys(calls[0].args)).not.toContain("p_joined_at");
    expect(tableTouches).toEqual([]);
  });

  it("an omitted preference stays NULL — never 'both'", async () => {
    arrangeRpc({ data: rows("created") });
    await addWaitlistEntryAction(form({ name: "Jo", email: "jo@example.com" }));
    expect(calls[0].args.p_preference).toBeNull();
    expect(calls[0].args.p_phone).toBeNull();
  });

  it("refuses a blank name or email without calling the command", async () => {
    arrangeRpc({ data: rows("created") });
    for (const fields of [
      { name: "  ", email: "jo@example.com" },
      { name: "Jo", email: "   " },
      { name: "Jo" },
    ]) {
      const res = await addWaitlistEntryAction(form(fields as Record<string, string>));
      expect(res.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("reads a TABLE-shaped refusal as a refusal, not a success", async () => {
    // The scalar commands return a string; these return rows. Reading `data`
    // as a string here would make every outcome — including `created` — look
    // like a refusal, and reading truthiness would make every refusal look
    // like a success.
    arrangeRpc({ data: rows("already_waiting") });
    const res = await addWaitlistEntryAction(form({ name: "Jo", email: "jo@example.com" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("already waiting");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an empty result set is a refusal", async () => {
    arrangeRpc({ data: [] });
    const res = await addWaitlistEntryAction(form({ name: "Jo", email: "jo@example.com" }));
    expect(res.ok).toBe(false);
  });

  it("a transport error is a refusal and is logged WITHOUT the person's details", async () => {
    arrangeRpc({ data: null, error: { code: "PGRST301" } });
    const res = await addWaitlistEntryAction(
      form({ name: "Jo Smith", email: "jo@example.com", phone: "555 0100" }),
    );
    expect(res.ok).toBe(false);
    const log = errors.join("\n");
    expect(log).toContain("waitlist_manual_entry_failed");
    expect(log).not.toContain("Jo Smith");
    expect(log).not.toContain("jo@example.com");
    expect(log).not.toContain("555 0100");
  });
});

// ---------------------------------------------------------------------------

describe("legacy import", () => {
  it("sends the supplied date under operator_supplied provenance", async () => {
    arrangeRpc({ data: rows("imported") });
    const res = await importLegacyWaitlistEntryAction(
      form({
        name: "Ada",
        email: "ada@example.com",
        provenance: "operator_supplied",
        joined_at: "2025-03-04",
      }),
    );

    expect(res).toEqual({ ok: true });
    expect(calls[0].name).toBe("import_legacy_waitlist_entry");
    expect(calls[0].args.p_provenance).toBe("operator_supplied");
    // NOT the bare string. Local midnight in the studio's own zone, as an
    // explicit instant, so the database session's timezone decides nothing.
    expect(calls[0].args.p_joined_at).toBe("2025-03-04T05:00:00.000Z");
    expect(localDateString(new Date(String(calls[0].args.p_joined_at)), "America/Toronto")).toBe(
      "2025-03-04",
    );
  });

  it("under UNKNOWN provenance it sends NO date, even when the field is filled", async () => {
    // A date left in the form by a change of mind must not leak into a row the
    // studio just said it has no date for. The command would stamp its own
    // import instant and record `unknown`; sending a date would instead assert
    // a join date nobody stands behind.
    arrangeRpc({ data: rows("imported") });
    await importLegacyWaitlistEntryAction(
      form({
        name: "Ada",
        email: "ada@example.com",
        provenance: "unknown",
        joined_at: "2025-03-04",
      }),
    );
    expect(calls[0].args.p_provenance).toBe("unknown");
    expect(calls[0].args.p_joined_at).toBeNull();
  });

  it("refuses to offer 'form' provenance at all", async () => {
    // 0193's CHECK binds `form` to source = 'public_booking'. Only the public
    // form may claim the form stamped it, and this path must not even ask.
    arrangeRpc({ data: rows("imported") });
    const res = await importLegacyWaitlistEntryAction(
      form({ name: "Ada", email: "ada@example.com", provenance: "form", joined_at: "2025-03-04" }),
    );
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("requires a date when the studio says it has one", async () => {
    arrangeRpc({ data: rows("imported") });
    const res = await importLegacyWaitlistEntryAction(
      form({ name: "Ada", email: "ada@example.com", provenance: "operator_supplied" }),
    );
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("requires a provenance — a blank answer is not 'unknown'", async () => {
    // Defaulting to `unknown` would silently discard a date the studio has,
    // and defaulting to `operator_supplied` would assert one it does not.
    arrangeRpc({ data: rows("imported") });
    const res = await importLegacyWaitlistEntryAction(
      form({ name: "Ada", email: "ada@example.com" }),
    );
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("explains a future date in the studio's language", async () => {
    arrangeRpc({ data: rows("joined_at_in_future") });
    const res = await importLegacyWaitlistEntryAction(
      form({
        name: "Ada",
        email: "ada@example.com",
        provenance: "operator_supplied",
        joined_at: "2099-01-01",
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("future");
      expect(res.message).not.toContain("joined_at_in_future");
    }
  });

  it("a member is refused before the command is reached", async () => {
    arrangeActor("member");
    arrangeRpc({ data: rows("imported") });
    const res = await importLegacyWaitlistEntryAction(
      form({ name: "Ada", email: "ada@example.com", provenance: "unknown" }),
    );
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a practitioner with no user_id is refused rather than sending null", async () => {
    // Nullable in the schema for an invited practitioner who has never signed
    // in; the command would answer `invalid_input`, which says nothing useful.
    arrangeActor("owner", null);
    arrangeRpc({ data: rows("imported") });
    const res = await importLegacyWaitlistEntryAction(
      form({ name: "Ada", email: "ada@example.com", provenance: "unknown" }),
    );
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("source contract", () => {
  const src = readFileSync(
    join(process.cwd(), "app/(app)/settings/waitlist/profile-actions.ts"),
    "utf8",
  );

  it("performs NO DML of its own — every write is a 0193 command", () => {
    // The behavioural tests above throw if `.from()` is reached, but only on
    // the paths they exercise. This asserts it for the whole file.
    expect(src).not.toMatch(/\.from\(/);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });

  it("calls exactly the three 0193 commands and no other RPC", () => {
    const rpcNames = [...src.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(rpcNames).toEqual([
      "create_practitioner_waitlist_entry",
      "import_legacy_waitlist_entry",
      "set_waitlist_entry_availability",
    ]);
  });

  it("never reads a tenant or an actor from the form", () => {
    // The only `formData.get` calls are through the two named readers, and
    // neither a studio nor a user id is ever among the fields they read.
    for (const forbidden of ['"studio_id"', '"p_studio_id"', '"actor_user_id"', '"user_id"']) {
      expect(src, `${forbidden} read from the form`).not.toContain(`formData, ${forbidden}`);
    }
  });
});

// ===========================================================================
// P2 4028093980 — AN IMPORTED DATE IS A DATE IN THE STUDIO'S DAY
// ===========================================================================
//
// `p_joined_at` is `timestamptz`. A bare 'YYYY-MM-DD' lets the DATABASE
// SESSION's timezone decide which instant it names, and that session is UTC.
// Measured, before the repair:
//
//     America/Toronto  "2025-03-04" as UTC -> rendered back as 2025-03-03
//
// One day earlier than the practitioner typed — and `joined_at` is half of the
// (joined_at, id) total order, so the error is not cosmetic: it moves the
// person's position in the queue.

// ===========================================================================
// P2 4028386762 — THE EARLIEST REAL INSTANT OF A LOCAL CALENDAR DATE
// ===========================================================================
//
// THE PROPERTY, and the only one that matters:
//
//     the returned instant renders as the requested YYYY-MM-DD in the studio's
//     timezone, and NO EARLIER INSTANT DOES.
//
// The first repair sampled candidate wall-clock times and took the first that
// landed on the right date. That is a sampling answer to a boundary question,
// and it silently returned a LATER instant wherever a local day began off the
// sample grid — measured against real IANA data. `joined_at` is half of the
// (joined_at, id) queue order, so "30 minutes late" is a queue-position error,
// not a rounding detail.
//
// Refining the grid would have moved the failures, not removed them:
// Kiritimati's day begins on a 20-minute boundary. So every assertion below
// checks the PROPERTY rather than a grid, via `isFirstInstantOf`.
describe("the earliest real instant of a local date", () => {
  /**
   * The property itself, checked in one millisecond. This is the assertion the
   * whole suite is built on — a test that only checked "renders as ymd" would
   * pass on every instant of the day and would have passed on the defect.
   */
  function isFirstInstantOf(iso: string | null, ymd: string, tz: string): boolean {
    if (iso === null) return false;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return false;
    return (
      localDateString(new Date(t), tz) === ymd &&
      localDateString(new Date(t - 1), tz) !== ymd
    );
  }

  function firstInstant(ymd: string, tz: string): string | null {
    return studioLocalDateInstant(ymd, tz);
  }

  it("PARAMARIBO 1984-10-01 — the permanent regression case", () => {
    // The zone moved from -03:30 to -03:00 at midnight, so local 00:00 never
    // happened and the day began at local 00:30. No wall-clock string names
    // that instant; only the transition does.
    //
    // The hourly probe returned 1984-10-01T04:00:00.000Z — thirty minutes
    // after the day had already started, placing this person behind anyone
    // imported in that half hour.
    const tz = "America/Paramaribo";
    const iso = firstInstant("1984-10-01", tz);
    expect(iso).toBe("1984-10-01T03:30:00.000Z");
    expect(localDateString(new Date(Date.parse(iso!)), tz)).toBe("1984-10-01");
    expect(isFirstInstantOf(iso, "1984-10-01", tz)).toBe(true);
    // Stated as its own assertion so the defect cannot return quietly.
    expect(iso).not.toBe("1984-10-01T04:00:00.000Z");
  });

  it("FRACTIONAL and non-hour boundaries are exact, not rounded up", () => {
    // Every one of these was wrong under the hourly probe. The expected values
    // are the real transition instants, not a grid.
    for (const [tz, ymd, expected] of [
      ["America/Paramaribo", "1984-10-01", "1984-10-01T03:30:00.000Z"],
      ["Pacific/Rarotonga", "1984-10-28", "1984-10-28T10:00:00.000Z"],
      ["Pacific/Rarotonga", "1989-10-29", "1989-10-29T10:00:00.000Z"],
      ["Pacific/Kiritimati", "1979-10-01", "1979-10-01T10:40:00.000Z"],
    ] as const) {
      expect(firstInstant(ymd, tz), `${tz} ${ymd}`).toBe(expected);
      expect(isFirstInstantOf(expected, ymd, tz), `${tz} ${ymd} property`).toBe(true);
    }
  });

  it("REPEATED MIDNIGHT resolves to the EARLIER occurrence", () => {
    // Europe/Sofia fell back exactly at midnight on 1979-10-01, so local 00:00
    // happened TWICE — at 21:00Z and again at 22:00Z. The day began at the
    // first one.
    //
    // This is the case that killed the offset-correction approach: correcting
    // the offset twice converged on 22:00Z, an hour into a day that had already
    // started. The first-instant property caught it and turned a wrong instant
    // into a refusal, which is how a real date came to be rejected outright.
    const tz = "Europe/Sofia";
    const iso = firstInstant("1979-10-01", tz);
    expect(iso).toBe("1979-09-30T21:00:00.000Z");
    expect(isFirstInstantOf(iso, "1979-10-01", tz)).toBe(true);
    // Both are local midnight of the same date; only the first begins the day.
    expect(localTimeString(new Date("1979-09-30T22:00:00.000Z"), tz)).toBe("00:00");
    expect(localDateString(new Date("1979-09-30T22:00:00.000Z"), tz)).toBe("1979-10-01");
    expect(iso).not.toBe("1979-09-30T22:00:00.000Z");
  });

  it("ORDINARY MIDNIGHT resolves to midnight", () => {
    const iso = firstInstant("2025-03-04", "America/Toronto");
    expect(iso).toBe("2025-03-04T05:00:00.000Z");
    expect(localTimeString(new Date(Date.parse(iso!)), "America/Toronto")).toBe("00:00");
    expect(isFirstInstantOf(iso, "2025-03-04", "America/Toronto")).toBe(true);
    // The defect this whole conversion exists to remove: the naive UTC reading
    // renders the PREVIOUS day.
    expect(localDateString(new Date("2025-03-04T00:00:00.000Z"), "America/Toronto")).toBe(
      "2025-03-03",
    );
  });

  it("SKIPPED MIDNIGHT resolves to the first representable instant", () => {
    // These zones shift forward AT midnight, so the day starts at 01:00 local.
    for (const [tz, ymd, expected] of [
      ["America/Santiago", "2025-09-07", "2025-09-07T04:00:00.000Z"],
      ["America/Havana", "2025-03-09", "2025-03-09T05:00:00.000Z"],
    ] as const) {
      const iso = firstInstant(ymd, tz);
      expect(iso, `${tz} ${ymd}`).toBe(expected);
      expect(localTimeString(new Date(Date.parse(iso!)), tz), `${tz} ${ymd}`).toBe("01:00");
      expect(isFirstInstantOf(iso, ymd, tz), `${tz} ${ymd} property`).toBe(true);
    }
  });

  it("POSITIVE and NEGATIVE UTC offsets both hold the property", () => {
    for (const [tz, ymd] of [
      ["Australia/Sydney", "2025-03-04"],
      ["Pacific/Auckland", "2025-06-15"],
      ["Asia/Kolkata", "2025-03-04"],
      ["Asia/Kathmandu", "2025-03-04"],
      ["America/Toronto", "2025-07-04"],
      ["America/St_Johns", "2025-07-04"],
      ["Pacific/Marquesas", "2025-07-04"],
    ] as const) {
      expect(isFirstInstantOf(firstInstant(ymd, tz), ymd, tz), `${tz} ${ymd}`).toBe(true);
    }
    // Non-hour offsets land off the hour, which is the point of asserting them.
    expect(firstInstant("2025-03-04", "Asia/Kolkata")).toBe("2025-03-03T18:30:00.000Z");
    expect(firstInstant("2025-03-04", "Asia/Kathmandu")).toBe("2025-03-03T18:15:00.000Z");
  });

  it("DST boundaries, forward and backward, hold the property", () => {
    for (const [tz, ymd] of [
      ["America/Toronto", "2026-03-08"],
      ["America/Toronto", "2025-11-02"],
      ["Australia/Sydney", "2025-10-05"],
      ["Australia/Sydney", "2025-04-06"],
      ["Pacific/Auckland", "2025-09-28"],
      ["Asia/Beirut", "2025-03-30"],
      ["Australia/Lord_Howe", "2025-10-05"],
      ["Australia/Lord_Howe", "2025-04-06"],
    ] as const) {
      expect(isFirstInstantOf(firstInstant(ymd, tz), ymd, tz), `${tz} ${ymd}`).toBe(true);
    }
  });

  it("HISTORICAL non-hour offsets hold the property", () => {
    for (const [tz, ymd] of [
      ["America/Toronto", "2009-05-14"],
      ["America/Toronto", "1996-01-02"],
      ["Australia/Sydney", "2001-09-11"],
      ["Europe/Lisbon", "1985-07-01"],
      ["Asia/Kolkata", "1974-11-30"],
      ["Europe/Amsterdam", "1970-05-01"],
      ["Asia/Singapore", "1981-12-31"],
      ["America/Paramaribo", "1975-06-01"],
    ] as const) {
      expect(isFirstInstantOf(firstInstant(ymd, tz), ymd, tz), `${tz} ${ymd}`).toBe(true);
    }
  });

  it("TODAY in a positive-offset zone is never pushed into the future", () => {
    // The command refuses a future `joined_at`, so a legitimate import must not
    // be manufactured into one.
    for (const tz of ["Australia/Sydney", "Pacific/Auckland", "Asia/Kathmandu"]) {
      const today = localDateString(new Date(), tz);
      const iso = firstInstant(today, tz);
      expect(isFirstInstantOf(iso, today, tz), `${tz} today`).toBe(true);
      expect(Date.parse(iso!)).toBeLessThanOrEqual(Date.now());
    }
  });

  it("A SKIPPED LOCAL DATE is refused — there is no first instant to return", () => {
    // Both zones crossed the date line and the calendar date never occurred
    // locally. Returning any instant would name a day that did not happen.
    expect(firstInstant("2011-12-30", "Pacific/Apia")).toBeNull();
    expect(firstInstant("1994-12-31", "Pacific/Kiritimati")).toBeNull();
  });

  it("an INVALID or ABSENT timezone is refused, never read as UTC", () => {
    for (const tz of ["Not/AZone", "", "UTC+5", "America/Atlantis"]) {
      expect(firstInstant("2025-03-04", tz), tz).toBeNull();
    }
    expect(studioLocalDateInstant("2025-03-04", null)).toBeNull();
  });

  it("an impossible calendar date is refused", () => {
    for (const ymd of ["2025-02-30", "2025-13-01", "2025-00-10", "2025-04-31"]) {
      expect(firstInstant(ymd, "America/Toronto"), ymd).toBeNull();
    }
  });

  it("a malformed date string is refused before any conversion", () => {
    for (const ymd of ["04/03/2025", "2025-3-4", "yesterday", "", "2025-03-04T00:00:00Z"]) {
      expect(firstInstant(ymd, "America/Toronto"), ymd).toBeNull();
    }
  });

  it("SWEEP — the property holds across every zone the platform knows", () => {
    // Not a spot check: the defect was invisible precisely because the obvious
    // zones were fine. Sampled across zones and decades, every answer must
    // either be the first instant or an honest refusal.
    const zones: string[] =
      typeof (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
        .supportedValuesOf === "function"
        ? (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf(
            "timeZone",
          )
        : ["America/Toronto", "Australia/Sydney", "America/Paramaribo"];
    expect(zones.length).toBeGreaterThan(50);

    // SAMPLED, AND SAID SO. The full set costs ~11s of Intl work, and a
    // CPU-bound test that long starves its neighbours: it pushed an unrelated
    // 15s booking test into a timeout when the suite ran them concurrently.
    // Every fourth zone keeps the breadth that makes this sweep worth having,
    // and every zone known to be hard is added back explicitly so the sampling
    // can never drop the cases this repair exists for.
    const HARD_ZONES = [
      "America/Paramaribo",
      "Pacific/Kiritimati",
      "Pacific/Rarotonga",
      "Europe/Sofia",
      "America/Santiago",
      "America/Havana",
      "Australia/Lord_Howe",
      "Pacific/Apia",
    ];
    const sampled = Array.from(
      new Set([...zones.filter((_, i) => i % 4 === 0), ...HARD_ZONES.filter((z) => zones.includes(z))]),
    );
    expect(sampled.length).toBeGreaterThan(40);
    for (const hard of HARD_ZONES) {
      if (zones.includes(hard)) expect(sampled, `${hard} was sampled out`).toContain(hard);
    }

    const failures: string[] = [];
    for (const tz of sampled) {
      // The four dates that carry every hard case between them: Kiritimati's
      // 20-minute boundary and Sofia's repeated midnight (1979-10-01),
      // Paramaribo's skipped fractional midnight (1984-10-01), Rarotonga's
      // half-hour boundary (1984-10-28), and an ordinary modern transition.
      // Dates that do not exist anywhere are covered by their own test; they
      // are excluded here only because the sweep's cost is per zone-date and
      // this lane's budget is real.
      for (const ymd of ["1979-10-01", "1984-10-01", "1984-10-28", "2025-03-09"]) {
        const iso = firstInstant(ymd, tz);
        if (iso === null) {
          // A refusal is only honest when no instant renders as that date.
          const base = Date.parse(`${ymd}T00:00:00.000Z`);
          let exists = false;
          for (let h = -14; h <= 14 && !exists; h += 1) {
            if (localDateString(new Date(base + h * 3_600_000), tz) === ymd) exists = true;
          }
          if (exists) failures.push(`false refusal: ${tz} ${ymd}`);
          continue;
        }
        if (!isFirstInstantOf(iso, ymd, tz)) failures.push(`not first instant: ${tz} ${ymd} ${iso}`);
      }
    }
    expect(failures).toEqual([]);
    // EXPLICIT BUDGET, well above the measured ~2.5s so a slow runner does not
    // turn breadth into a red.
  }, 30_000);

  it("the ACTION refuses rather than importing when the studio has no timezone", async () => {
    arrangeActor("owner", ACTOR, null);
    arrangeRpc({ data: rows("imported") });
    const res = await importLegacyWaitlistEntryAction(
      form({
        name: "Ada",
        email: "ada@example.com",
        provenance: "operator_supplied",
        joined_at: "2025-03-04",
      }),
    );
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("unresolvable_local_date");
  });

  it("the ACTION sends the first instant end to end", async () => {
    arrangeActor("owner", ACTOR, "Australia/Sydney");
    arrangeRpc({ data: rows("imported") });
    await importLegacyWaitlistEntryAction(
      form({
        name: "Ada",
        email: "ada@example.com",
        provenance: "operator_supplied",
        joined_at: "2024-12-25",
      }),
    );
    const sent = String(calls[0].args.p_joined_at);
    expect(isFirstInstantOf(sent, "2024-12-25", "Australia/Sydney")).toBe(true);
  });

  it("still sends NO date under unknown provenance, whatever the timezone", async () => {
    arrangeActor("owner", ACTOR, "Australia/Sydney");
    arrangeRpc({ data: rows("imported") });
    await importLegacyWaitlistEntryAction(
      form({ name: "Ada", email: "ada@example.com", provenance: "unknown", joined_at: "2024-12-25" }),
    );
    expect(calls[0].args.p_joined_at).toBeNull();
  });

  it("SOURCE CONTRACT — a boundary search, not a wall-clock grid", () => {
    const src = readFileSync(join(process.cwd(), "lib/waitlist/studio-local-date.ts"), "utf8");
    // The existing timezone machinery, not a new dependency and not a second
    // date implementation.
    expect(src).toContain("@/lib/booking/tz");
    expect(src).toContain("tzOffsetMinutes");
    expect(src).toContain("localDateString");
    // `new Date("YYYY-MM-DD")` parses as UTC, which IS the defect.
    expect(src).not.toMatch(/new Date\(\s*(typed|ymd|joinedAt|localDate)\s*\)/);
    // No date library was added.
    expect(src).not.toMatch(/from "(date-fns|luxon|dayjs|moment|@js-joda)/);
    // And the action file must not have grown its own second implementation.
    const action = readFileSync(
      join(process.cwd(), "app/(app)/settings/waitlist/profile-actions.ts"),
      "utf8",
    );
    expect(action).not.toContain("tzOffsetMinutes");
    expect(action).not.toMatch(/new Date\([^)]+\)/);
  });
});
