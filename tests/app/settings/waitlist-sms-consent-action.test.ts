import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// 0208 — THE OWNER RECORDS SMS CONSENT GIVEN OUTSIDE HONE
// ===========================================================================
//
// THESE PROVE THE SEAM, NOT THE RULE. Owner re-derivation, the write-once
// guard, the refusal order and the record's shape belong to migration 0208 and
// are proved in tests/db/waitlist-sms-consent-practitioner-and-signup.db.test.ts.
// What can go wrong HERE is the wiring:
//
//   * trusting a browser-supplied tenant, actor, source or timestamp;
//   * calling the command when an answer is missing, so a default the owner
//     never gave becomes the record;
//   * calling it for a number that already said STOP through ANOTHER row,
//     which the command cannot see (phone matching lives in TypeScript);
//   * reading a failed opt-out check as "not opted out";
//   * recording consent on a number the sender can never text (Codex P2
//     4234615500);
//   * reading a refusal as a success, or leaking a code or PII.
//
// The phone-wide check runs through the REAL lookup and the REAL matching law,
// against a fake admin client that answers like PostgREST (row-limited pages),
// so "a differently formatted number in another studio" is decided by the same
// code the STOP route uses.

import { pagedSource } from "@/tests/lib/sms/helpers/postgrest-pages";

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin-server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { revalidatePath } from "next/cache";
import {
  recordProspectSmsConsentAction,
  recordProspectSmsConsentFormAction,
} from "@/app/(app)/settings/waitlist/consent-actions";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const ENTRY = "33333333-3333-4333-8333-333333333333";
const FOREIGN = "99999999-9999-4999-8999-999999999999";
const OPTED_OUT = "2026-09-01T10:00:00.000Z";
const EVIDENCE = "Owner confirmation 2026-10-09: agreed in person at intake";
const ENTRY_PHONE = "+1 (416) 555-0100";

const OWNER_ONLY = "Only the studio owner can record SMS consent.";
const CHECK_FAILED =
  "Couldn't check this number against opt-outs. Nothing was recorded. Please try again.";
const STOPPED = "This number replied STOP to Hone texts. Consent can't be recorded for it.";

type Candidate = { id: string; studio_id: string; phone: string | null; sms_opted_out_at: string | null };

const h = {
  entry: { phone: ENTRY_PHONE } as { phone: string | null } | null,
  entryError: null as { code: string } | null,
  entryThrows: false,
  optedOutClients: [] as Candidate[],
  clientsError: null as { code: string } | null,
  prospects: [] as Candidate[],
  prospectsError: null as { code: string } | null,
  result: "recorded" as unknown,
  commandError: null as { code: string } | null,
};

let commands: Array<{ name: string; args: Record<string, unknown> }> = [];
let adminReads: string[] = [];
let sessionReads: Array<{ table: string; columns: string; filters: unknown[][] }> = [];
let errors: string[] = [];

function arrangeClients() {
  vi.mocked(createClient).mockImplementation(async () => {
    if (h.entryThrows) throw new Error("cookies() unavailable");
    return {
      from(table: string) {
        const read = { table, columns: "", filters: [] as unknown[][] };
        sessionReads.push(read);
        const builder = {
          select(columns: string) {
            read.columns = columns;
            return builder;
          },
          eq(column: string, value: unknown) {
            read.filters.push(["eq", column, value]);
            return builder;
          },
          maybeSingle: async () => ({ data: h.entryError ? null : h.entry, error: h.entryError }),
        };
        return builder;
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>;
  });

  vi.mocked(createAdminClient).mockReturnValue({
    from(table: string) {
      adminReads.push(`from:${table}`);
      // The phone-wide read is the ONLY table the service role may touch here,
      // and only to read. Anything else is a design error, not a fallback.
      if (table !== "clients") throw new Error(`unexpected admin table: ${table}`);
      return pagedSource(() => h.optedOutClients, { fail: () => h.clientsError !== null }).query();
    },
    rpc(name: string, args?: Record<string, unknown>) {
      if (name === "waitlist_prospect_suppression_candidates") {
        adminReads.push(`rpc:${name}`);
        return pagedSource(() => h.prospects, { fail: () => h.prospectsError !== null }).query();
      }
      commands.push({ name, args: args ?? {} });
      return Promise.resolve({ data: h.commandError ? null : h.result, error: h.commandError });
    },
  } as unknown as ReturnType<typeof createAdminClient>);
}

function arrangeActor(
  role: "owner" | "practitioner" = "owner",
  userId: string | null = ACTOR,
  timezone: string | null = "America/Toronto",
) {
  vi.mocked(getCurrentPractitionerWithStudio).mockResolvedValue({
    practitioner: { role, user_id: userId },
    studio: { id: STUDIO, timezone },
  } as unknown as Awaited<ReturnType<typeof getCurrentPractitionerWithStudio>>);
}

function form(over: Record<string, string | null> = {}): FormData {
  const fields: Record<string, string | null> = {
    entry_id: ENTRY,
    sms_consent_attest: "yes",
    sms_consent_evidence_ref: `  ${EVIDENCE}  `,
    sms_consent_date_known: "unknown",
    ...over,
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== null) fd.set(k, v);
  return fd;
}

const record = (over: Record<string, string | null> = {}) => recordProspectSmsConsentAction(form(over));

beforeEach(() => {
  h.entry = { phone: ENTRY_PHONE };
  h.entryError = null;
  h.entryThrows = false;
  h.optedOutClients = [];
  h.clientsError = null;
  h.prospects = [];
  h.prospectsError = null;
  h.result = "recorded";
  h.commandError = null;
  commands = [];
  adminReads = [];
  sessionReads = [];
  errors = [];
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
  arrangeActor();
  arrangeClients();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recording", () => {
  it("calls 0208's command once, with the SESSION's studio and actor and the owner's answers", async () => {
    expect(await record()).toEqual({ ok: true });
    expect(commands).toEqual([
      {
        name: "record_waitlist_sms_consent_by_practitioner",
        args: {
          p_studio_id: STUDIO,
          p_entry_id: ENTRY,
          p_actor_user_id: ACTOR,
          p_scope: "waitlist_operational",
          p_evidence_ref: EVIDENCE,
          p_consent_date_known: false,
          p_consent_given_on: null,
        },
      },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/settings/waitlist");
  });

  it("a known day is passed exactly as entered", async () => {
    await record({ sms_consent_date_known: "known", sms_consent_given_on: "2026-03-01" });
    expect(commands[0].args).toMatchObject({
      p_consent_date_known: true,
      p_consent_given_on: "2026-03-01",
    });
  });

  it("IGNORES a browser-supplied studio, actor, source, wording or timestamp", async () => {
    await record({
      studio_id: FOREIGN,
      p_studio_id: FOREIGN,
      actor_user_id: FOREIGN,
      p_actor_user_id: FOREIGN,
      sms_consent_source: "public_form",
      sms_consent_text_version: "waitlist_sms_operational_v1",
      sms_consent_at: "2020-01-01T00:00:00Z",
      p_scope: "marketing",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0].args.p_studio_id).toBe(STUDIO);
    expect(commands[0].args.p_actor_user_id).toBe(ACTOR);
    expect(commands[0].args.p_scope).toBe("waitlist_operational");
    // The command takes no source, wording or time at all: it stamps
    // `practitioner`, no wording, and its own clock.
    expect(Object.keys(commands[0].args).sort()).toEqual([
      "p_actor_user_id",
      "p_consent_date_known",
      "p_consent_given_on",
      "p_entry_id",
      "p_evidence_ref",
      "p_scope",
      "p_studio_id",
    ]);
    expect(JSON.stringify(commands[0].args)).not.toContain(FOREIGN);
  });

  it("reads the entry's number through the owner's own session, scoped by id AND studio", async () => {
    await record();
    expect(sessionReads).toEqual([
      {
        table: "new_client_waitlist_entries",
        columns: "phone",
        filters: [
          ["eq", "id", ENTRY],
          ["eq", "studio_id", STUDIO],
        ],
      },
    ]);
  });

  it("'today' is the STUDIO's day: a day that is tomorrow in Toronto is refused", async () => {
    vi.useFakeTimers();
    // 02:00 UTC on the 10th is still the 9th in Toronto.
    vi.setSystemTime(new Date("2026-10-10T02:00:00.000Z"));
    expect(await record({ sms_consent_date_known: "known", sms_consent_given_on: "2026-10-10" })).toEqual({
      ok: false,
      message: "The day they agreed can't be in the future.",
    });
    expect(commands).toEqual([]);
    expect(await record({ sms_consent_date_known: "known", sms_consent_given_on: "2026-10-09" })).toEqual({
      ok: true,
    });
  });

  it("a studio with no timezone uses UTC, as the command does", async () => {
    arrangeActor("owner", ACTOR, null);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T02:00:00.000Z"));
    expect(await record({ sms_consent_date_known: "known", sms_consent_given_on: "2026-10-10" })).toEqual({
      ok: true,
    });
  });

  it("the useActionState binding is the same action", async () => {
    expect(await recordProspectSmsConsentFormAction(null, form())).toEqual({ ok: true });
    expect(commands).toHaveLength(1);
  });
});

describe("authorization", () => {
  it("a non-owner is refused before any read or command", async () => {
    arrangeActor("practitioner");
    expect(await record()).toEqual({ ok: false, message: OWNER_ONLY });
    expect(sessionReads).toEqual([]);
    expect(adminReads).toEqual([]);
    expect(commands).toEqual([]);
  });

  it("an owner row with no signed-in user is refused, never passed as a null actor", async () => {
    arrangeActor("owner", null);
    expect(await record()).toEqual({ ok: false, message: OWNER_ONLY });
    expect(commands).toEqual([]);
  });

  it("an identity failure is a retry, not a claim about the role", async () => {
    vi.mocked(getCurrentPractitionerWithStudio).mockRejectedValue(new Error("no session"));
    expect(await record()).toEqual({
      ok: false,
      message: "We couldn't confirm your studio just now. Please try again.",
    });
    expect(commands).toEqual([]);
  });

  it("the COMMAND is the guarantee: its own owner refusals reach the owner as such", async () => {
    // A role changed between this action's check and the command's.
    for (const code of ["not_owner", "not_a_member"]) {
      commands = [];
      h.result = code;
      expect(await record()).toEqual({ ok: false, message: OWNER_ONLY });
      expect(commands).toHaveLength(1);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("missing answers are refused before anything runs", () => {
  const CASES: ReadonlyArray<[string, Record<string, string | null>, RegExp]> = [
    ["no entry", { entry_id: null }, /^Missing waitlist entry\.$/],
    ["a non-id entry", { entry_id: "../../etc" }, /^Missing waitlist entry\.$/],
    ["no attestation", { sms_consent_attest: null }, /^Confirm the person agreed to texts/],
    ["a checkbox default instead of yes", { sms_consent_attest: "on" }, /^Confirm the person agreed/],
    ["no evidence", { sms_consent_evidence_ref: null }, /evidence/],
    ["blank evidence", { sms_consent_evidence_ref: "   " }, /evidence/],
    ["multi-line evidence", { sms_consent_evidence_ref: "line one\nline two" }, /evidence/],
    ["no day answer", { sms_consent_date_known: null }, /^Say whether you know the day/],
    ["known but no day", { sms_consent_date_known: "known" }, /^Enter the day they agreed/],
    [
      "known with an impossible day",
      { sms_consent_date_known: "known", sms_consent_given_on: "2026-02-30" },
      /^Enter the day they agreed/,
    ],
    [
      "known before 2000",
      { sms_consent_date_known: "known", sms_consent_given_on: "1999-12-31" },
      /from 2000 onward/,
    ],
  ];

  for (const [label, over, message] of CASES) {
    it(`${label}: refused, nothing read, nothing recorded`, async () => {
      const result = await record(over);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toMatch(message);
      expect(sessionReads).toEqual([]);
      expect(adminReads).toEqual([]);
      expect(commands).toEqual([]);
    });
  }
});

describe("repeat recording", () => {
  it("existing consent is reported as kept, never replaced, and nothing is revalidated", async () => {
    h.result = "already_consented";
    expect(await record()).toEqual({
      ok: false,
      message:
        "This person already has SMS consent on record. Nothing was changed: existing consent is never replaced.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("STOP wins, phone-wide, before the command runs", () => {
  it("the entry's OWN stamped row refuses it", async () => {
    h.prospects = [{ id: ENTRY, studio_id: STUDIO, phone: ENTRY_PHONE, sms_opted_out_at: OPTED_OUT }];
    expect(await record()).toEqual({ ok: false, message: STOPPED });
    expect(commands).toEqual([]);
  });

  it("a CLIENT in ANOTHER studio who said STOP from the same number, typed differently, refuses it", async () => {
    h.optedOutClients = [
      { id: "client-b", studio_id: FOREIGN, phone: "416.555.0100", sms_opted_out_at: OPTED_OUT },
    ];
    expect(await record()).toEqual({ ok: false, message: STOPPED });
    expect(commands).toEqual([]);
  });

  it("another studio's PROSPECT who said STOP from the same number refuses it", async () => {
    h.prospects = [
      { id: "prospect-b", studio_id: FOREIGN, phone: "14165550100", sms_opted_out_at: OPTED_OUT },
    ];
    expect(await record()).toEqual({ ok: false, message: STOPPED });
    expect(commands).toEqual([]);
  });

  it("an unstamped match, or a STOP from a different number, does not", async () => {
    h.prospects = [
      { id: "prospect-b", studio_id: FOREIGN, phone: ENTRY_PHONE, sms_opted_out_at: null },
      { id: "prospect-c", studio_id: FOREIGN, phone: "+14165550199", sms_opted_out_at: OPTED_OUT },
    ];
    expect(await record()).toEqual({ ok: true });
    expect(commands).toHaveLength(1);
  });

  it("the command's own STOP refusal still reaches the owner (a STOP after the check)", async () => {
    h.result = "opted_out";
    expect(await record()).toEqual({
      ok: false,
      message: "This person replied STOP. Consent can't be recorded for them.",
    });
  });

  for (const [label, arrange] of [
    ["the entry read errors", () => (h.entryError = { code: "57014" })],
    ["the entry read throws", () => (h.entryThrows = true)],
    ["the clients read errors", () => (h.clientsError = { code: "57014" })],
    ["the prospects read errors", () => (h.prospectsError = { code: "PGRST202" })],
  ] as const) {
    it(`FAILS CLOSED when ${label}: nothing recorded, and it says so`, async () => {
      arrange();
      expect(await record()).toEqual({ ok: false, message: CHECK_FAILED });
      expect(commands).toEqual([]);
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }

  it("an entry with no number skips the check and lets the command refuse it", async () => {
    h.entry = { phone: null };
    h.result = "no_phone";
    expect(await record()).toEqual({
      ok: false,
      message: "There's no mobile number on file for this person, so consent can't be recorded.",
    });
    expect(adminReads).toEqual([]);
    expect(commands).toHaveLength(1);
  });

  it("an entry the session cannot see is left to the command, which says not found", async () => {
    h.entry = null;
    h.result = "not_found";
    expect(await record()).toEqual({
      ok: false,
      message: "That person is no longer on this studio's waitlist.",
    });
    expect(adminReads).toEqual([]);
  });
});

describe("result mapping and log hygiene", () => {
  it("every refusal maps to plain copy, and no internal code reaches the owner", async () => {
    for (const code of [
      "already_consented",
      "opted_out",
      "no_phone",
      "not_active",
      "not_found",
      "not_owner",
      "not_a_member",
      "invalid_input",
      "some_future_code",
      null,
    ]) {
      h.result = code;
      const result = await record();
      expect(result.ok, String(code)).toBe(false);
      const message = !result.ok ? result.message : "";
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/_/);
    }
  });

  it("a transport error is a generic retry, never a success", async () => {
    h.commandError = { code: "08006" };
    expect(await record()).toEqual({
      ok: false,
      message: "Couldn't record that consent. Please try again.",
    });
  });

  it("logs the studio and an outcome code, never the number, the evidence or the day", async () => {
    h.optedOutClients = [
      { id: "client-b", studio_id: FOREIGN, phone: "416.555.0100", sms_opted_out_at: OPTED_OUT },
    ];
    await record({ sms_consent_date_known: "known", sms_consent_given_on: "2026-03-01" });
    h.optedOutClients = [];
    h.result = "already_consented";
    await record({ sms_consent_date_known: "known", sms_consent_given_on: "2026-03-01" });
    expect(errors).toHaveLength(2);
    for (const line of errors) {
      const parsed = JSON.parse(line);
      expect(parsed.event).toBe("waitlist_sms_consent_record_failed");
      expect(parsed.studioId).toBe(STUDIO);
      expect(line).not.toMatch(/555|0100|Owner confirmation|2026-03-01/);
    }
    expect(JSON.parse(errors[0]).outcome).toBe("phone_suppressed");
    expect(JSON.parse(errors[1]).outcome).toBe("already_consented");
  });
});

// ===========================================================================
// ONLY A NUMBER THE SENDER CAN TEXT (Codex P2 4234615500). Consent binds to the
// entry's number, so the owner records it only when the invitation sender's own
// law (normalizePhoneForSms) accepts that number. Otherwise every invitation
// would settle `invalid_phone`. Refused before the phone-wide read and the
// command, with plain copy; no number at all is still the command's `no_phone`.
// ===========================================================================
describe("a number the sender cannot text is refused before anything runs", () => {
  for (const phone of ["555 0142", "604 555 01", "44 7700 900123", "2 604 555 0199"]) {
    it(`an entry whose number is ${phone}`, async () => {
      h.entry = { phone };
      expect(await record()).toEqual({
        ok: false,
        message: "The number on file can't receive texts, so consent can't be recorded.",
      });
      expect(adminReads, "no phone-wide read for a number that can't be texted").toEqual([]);
      expect(commands, "the command must not run").toEqual([]);
      expect(revalidatePath).not.toHaveBeenCalled();
      expect(JSON.parse(errors[0]!).outcome).toBe("phone_not_textable");
      expect(errors.join(" ")).not.toContain(phone);
    });
  }

  for (const phone of ["604-555-0199", "+1 (416) 555-0100", "1 604 555 0199", "+44 7700 900123"]) {
    it(`control: a textable number (${phone}) is checked and recorded as before`, async () => {
      h.entry = { phone };
      expect(await record()).toEqual({ ok: true });
      expect(commands).toHaveLength(1);
    });
  }
});
