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
import { localDateString } from "@/lib/booking/tz";

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
describe("imported dates are converted in the studio's timezone", () => {
  /** The contract in one line: what is stored must render back as what was typed. */
  function roundTrips(ymd: string, tz: string): boolean {
    const iso = studioLocalDateInstant(ymd, tz);
    return iso !== null && localDateString(new Date(iso), tz) === ymd;
  }

  it("America/Toronto — the measured off-by-one is gone", () => {
    const iso = studioLocalDateInstant("2025-03-04", "America/Toronto");
    expect(iso).toBe("2025-03-04T05:00:00.000Z");
    expect(localDateString(new Date(iso!), "America/Toronto")).toBe("2025-03-04");
    // The defect, stated as its own assertion so it cannot quietly return: the
    // naive reading renders the PREVIOUS day.
    expect(localDateString(new Date("2025-03-04T00:00:00.000Z"), "America/Toronto")).toBe(
      "2025-03-03",
    );
  });

  it("POSITIVE-OFFSET zones — the calendar date survives AND the instant is right", () => {
    // East of Greenwich a bare date happens to render the right calendar day,
    // which is exactly why this case needs an instant assertion too: the naive
    // instant is hours late and would order this row behind people who joined
    // after them.
    expect(studioLocalDateInstant("2025-03-04", "Australia/Sydney")).toBe(
      "2025-03-03T13:00:00.000Z",
    );
    expect(studioLocalDateInstant("2025-03-04", "Asia/Kolkata")).toBe("2025-03-03T18:30:00.000Z");
    expect(roundTrips("2025-03-04", "Australia/Sydney")).toBe(true);
    expect(roundTrips("2025-03-04", "Asia/Kolkata")).toBe(true);
    expect(roundTrips("2025-06-15", "Pacific/Auckland")).toBe(true);
  });

  it("DST BOUNDARY DATES round-trip, including zones with NO local midnight", () => {
    // Ordinary spring-forward and fall-back dates, where midnight exists.
    for (const [tz, ymd] of [
      ["America/Toronto", "2026-03-08"],
      ["America/Toronto", "2025-11-02"],
      ["Australia/Sydney", "2025-10-05"],
      ["Australia/Sydney", "2025-04-06"],
      ["Pacific/Auckland", "2025-09-28"],
      ["Asia/Beirut", "2025-03-30"],
    ] as const) {
      expect(roundTrips(ymd, tz), `${tz} ${ymd}`).toBe(true);
    }

    // AND THE HARD ONES. These zones shift AT midnight, so 00:00 does not exist
    // on that date and a naive conversion lands on the day BEFORE. Measured:
    //   America/Santiago 2025-09-07 00:00 -> 2025-09-06
    //   America/Havana   2025-03-09 00:00 -> 2025-03-08
    // The probe walks forward to the first hour of that local day that exists.
    for (const [tz, ymd] of [
      ["America/Santiago", "2025-09-07"],
      ["America/Havana", "2025-03-09"],
    ] as const) {
      const iso = studioLocalDateInstant(ymd, tz);
      expect(iso, `${tz} ${ymd} was refused`).not.toBeNull();
      expect(localDateString(new Date(iso!), tz), `${tz} ${ymd}`).toBe(ymd);
    }
  });

  it("TODAY in a positive-offset zone is not pushed into the future", () => {
    // The command refuses a future `joined_at`. A studio in UTC+11 entering
    // today must produce an instant already past, or a legitimate import is
    // rejected as `joined_at_in_future`.
    for (const tz of ["Australia/Sydney", "Pacific/Auckland", "Asia/Kolkata"]) {
      const today = localDateString(new Date(), tz);
      const iso = studioLocalDateInstant(today, tz);
      expect(iso, `${tz} today`).not.toBeNull();
      expect(localDateString(new Date(iso!), tz)).toBe(today);
      expect(new Date(iso!).getTime()).toBeLessThanOrEqual(Date.now());
    }
  });

  it("HISTORICAL dates round-trip, across zones whose rules have since changed", () => {
    for (const [tz, ymd] of [
      ["America/Toronto", "2009-05-14"],
      ["America/Toronto", "1996-01-02"],
      ["Australia/Sydney", "2001-09-11"],
      ["Europe/Lisbon", "1985-07-01"],
      ["Asia/Kolkata", "1974-11-30"],
    ] as const) {
      expect(roundTrips(ymd, tz), `${tz} ${ymd}`).toBe(true);
    }
  });

  it("an INVALID studio timezone is refused, never silently read as UTC", () => {
    // Reinterpreting as UTC is the defect itself, and it would be invisible.
    for (const tz of ["Not/AZone", "", "UTC+5", "America/Atlantis"]) {
      expect(studioLocalDateInstant("2025-03-04", tz), tz).toBeNull();
    }
    expect(studioLocalDateInstant("2025-03-04", null)).toBeNull();
  });

  it("an impossible calendar date is refused by the round trip itself", () => {
    // No second calendar implementation: Feb 30th parses to March 2nd, which
    // fails to render back as what was typed.
    for (const ymd of ["2025-02-30", "2025-13-01", "2025-00-10", "2025-04-31"]) {
      expect(studioLocalDateInstant(ymd, "America/Toronto"), ymd).toBeNull();
    }
  });

  it("a malformed date string is refused before any conversion", () => {
    for (const ymd of ["04/03/2025", "2025-3-4", "yesterday", "", "2025-03-04T00:00:00Z"]) {
      expect(studioLocalDateInstant(ymd, "America/Toronto"), ymd).toBeNull();
    }
  });

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
    // The command is never reached: a guessed instant would move someone's
    // place in the queue.
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("unresolvable_local_date");
  });

  it("the ACTION sends a studio-local instant end to end", async () => {
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
    expect(sent).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(localDateString(new Date(sent), "Australia/Sydney")).toBe("2024-12-25");
  });

  it("still sends NO date under unknown provenance, whatever the timezone", async () => {
    arrangeActor("owner", ACTOR, "Australia/Sydney");
    arrangeRpc({ data: rows("imported") });
    await importLegacyWaitlistEntryAction(
      form({
        name: "Ada",
        email: "ada@example.com",
        provenance: "unknown",
        joined_at: "2024-12-25",
      }),
    );
    expect(calls[0].args.p_joined_at).toBeNull();
  });

  it("SOURCE CONTRACT — no naive Date parse is used as authority here", () => {
    const src = readFileSync(join(process.cwd(), "lib/waitlist/studio-local-date.ts"), "utf8");
    // `new Date("YYYY-MM-DD")` parses as UTC, which IS the defect. The only
    // Date construction permitted here re-reads what lib/booking/tz.ts
    // produced, never the typed string.
    expect(src).not.toMatch(/new Date\(\s*(typed|ymd|joinedAt|localDate)/);
    expect(src).toContain("utcInstantFromLocal");
    expect(src).toContain("localDateString");
    // And the action file must not have grown its own second implementation.
    const action = readFileSync(
      join(process.cwd(), "app/(app)/settings/waitlist/profile-actions.ts"),
      "utf8",
    );
    expect(action).not.toContain("utcInstantFromLocal");
    // ARGUMENT-TAKING constructions only. `new Date()` with no argument is the
    // log timestamp and parses nothing; forbidding it outright would be a
    // guard that fires on the wrong thing.
    expect(action).not.toMatch(/new Date\([^)]+\)/);
  });
});
