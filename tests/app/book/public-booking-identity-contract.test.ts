import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// SEC-01A — THE EXECUTABLE PUBLIC-BOOKING IDENTITY / ABUSE CONTRACT
// ===========================================================================
//
// WHAT THIS FILE IS. Today's behaviour of `publicBookAppointmentAction`,
// written down as assertions instead of prose. It drives the REAL action
// against an in-memory fake and asserts on OBSERVABLE outcomes -- what was
// written, what was returned -- rather than on source text.
//
// WHAT THIS FILE IS NOT. It is not the fix. Several cases below are SAFE and
// are pinned so they cannot regress. Several are NOT safe, and those are
// pinned as `KNOWN GAP` with the unsafe behaviour asserted EXACTLY as it is.
// A known gap is never made green by weakening the assertion or by asserting
// something vaguer than the defect: each one states the unsafe fact plainly,
// so closing it MUST break this file. That breakage is the signal, and the
// comment on each gap names what has to land to earn it.
//
// The two gaps here both need the identity-possession model (proving the
// submitter controls the address they typed). That is deliberately out of
// scope: it needs a schema, a token lifecycle and a UI, none of which belong
// in a contract file.
//
// HARNESS. No database. No Supabase. No reset. The fake models the three
// states that actually matter to identity -- an active client on file, no row
// at all, and an archived row that owns the email through the unique index --
// plus the outcome of the booking command. Every collaborator that could
// create business state records its calls, so "nothing was mutated" is a
// measured fact and not an inference from a passing return value.
// ===========================================================================

const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_STUDIO_ID = "99999999-9999-4999-8999-999999999999";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const EXISTING_CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const ARCHIVED_CLIENT_ID = "44444444-4444-4444-8444-444444444444";
const CREATED_CLIENT_ID = "77777777-7777-4777-8777-777777777777";
const APPT_ID = "66666666-6666-4666-8666-666666666666";
const SLUG = "contract-studio";

const VICTIM_EMAIL = "real.client@example.test";
const UNKNOWN_EMAIL = "nobody@example.test";
const ARCHIVED_EMAIL = "archived.client@example.test";

const START = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const START_ISO = START.toISOString();

// --- tripwires -------------------------------------------------------------
const dbWrites: Array<{ table: string; op: string }> = [];
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const intakeCalls: unknown[] = [];
const confirmationEmails: unknown[] = [];
const practitionerEmails: unknown[] = [];
const smsCalls: unknown[] = [];
const conversions: unknown[] = [];
const analyticsEvents: unknown[] = [];
const practitionerNotifications: unknown[] = [];
// Every (studio_id, normalized_email) pair the action presented to the clients
// lookup. Tenancy is asserted on this, not on intent.
const clientLookups: Array<{ studioId: unknown; normalizedEmail: unknown }> = [];

function resetTripwires() {
  for (const a of [
    dbWrites, rpcCalls, intakeCalls, confirmationEmails, practitionerEmails,
    smsCalls, conversions, analyticsEvents, practitionerNotifications,
    clientLookups,
  ]) a.length = 0;
}

// --- scenario knobs --------------------------------------------------------
type ClientRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  sms_consent_at: string | null;
  sms_opted_out_at: string | null;
};

const scenario: {
  // The ACTIVE (archived_at IS NULL) lookup result.
  activeClient: ClientRow | null;
  // What the clients INSERT does. "conflict_archived" reproduces an archived
  // row owning the email through clients_studio_normalized_email_uniq;
  // "conflict_active" reproduces the concurrent-insert race.
  insertOutcome: "ok" | "conflict_archived" | "conflict_active" | "error";
  // What create_public_appointment answers.
  commandResult: string;
} = {
  activeClient: null,
  insertOutcome: "ok",
  commandResult: "created",
};

const ACTIVE_CLIENT: ClientRow = {
  id: EXISTING_CLIENT_ID,
  name: "Real Client",
  email: VICTIM_EMAIL,
  phone: "+15550100",
  sms_consent_at: null,
  sms_opted_out_at: null,
};

function makeChain(table: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain as never;
  const filters: Record<string, unknown> = {};
  let didInsert = false;

  const listResult = () => {
    if (table === "services") return { count: 3, data: [], error: null };
    if (table === "studio_availability_default") {
      return {
        data: [
          { is_open: true, open_time: "09:00", close_time: "17:00" },
          { is_open: true, open_time: "09:00", close_time: "17:00" },
        ],
        error: null,
      };
    }
    return { data: null, error: null, count: 0 };
  };

  Object.assign(chain, {
    select: self,
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return chain as never;
    },
    is: (col: string, val: unknown) => {
      filters[col] = val;
      return chain as never;
    },
    not: self, in: self, order: self, limit: self,
    insert: () => {
      dbWrites.push({ table, op: "insert" });
      if (table === "clients") didInsert = true;
      return chain;
    },
    update: () => { dbWrites.push({ table, op: "update" }); return chain; },
    delete: () => { dbWrites.push({ table, op: "delete" }); return chain; },
    upsert: () => { dbWrites.push({ table, op: "upsert" }); return chain; },

    maybeSingle: async () => {
      if (table === "services") {
        return {
          data: {
            id: SERVICE_ID, studio_id: STUDIO_ID, name: "Consultation",
            modality: "consultation", default_duration_minutes: 45, active: true,
          },
          error: null,
        };
      }
      if (table === "clients") {
        clientLookups.push({
          studioId: filters["studio_id"],
          normalizedEmail: filters["normalized_email"],
        });
        // The 23505 re-read deliberately omits the archived filter, so it is
        // the read where `archived_at` is NOT among the filters.
        const isRaceReread = !("archived_at" in filters);
        if (isRaceReread) {
          if (scenario.insertOutcome === "conflict_archived") {
            return {
              data: {
                id: ARCHIVED_CLIENT_ID, name: "Archived Person", phone: null,
                sms_consent_at: null, sms_opted_out_at: null,
                archived_at: "2026-01-01T00:00:00.000Z",
              },
              error: null,
            };
          }
          if (scenario.insertOutcome === "conflict_active") {
            return {
              data: { ...ACTIVE_CLIENT, archived_at: null },
              error: null,
            };
          }
          return { data: null, error: null };
        }
        return { data: scenario.activeClient, error: null };
      }
      return { data: null, error: null };
    },

    single: async () => {
      if (table !== "clients" || !didInsert) return { data: null, error: null };
      if (scenario.insertOutcome === "ok") {
        return {
          data: {
            id: CREATED_CLIENT_ID, name: "New Booker", email: UNKNOWN_EMAIL,
            phone: "+15550111", sms_consent_at: null, sms_opted_out_at: null,
          },
          error: null,
        };
      }
      if (scenario.insertOutcome === "error") {
        return { data: null, error: { code: "XX000" } };
      }
      // Both conflict flavours trip the partial unique index.
      return { data: null, error: { code: "23505" } };
    },

    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(listResult()).then(resolve),
  });
  return chain;
}

const admin = {
  from: (table: string) => makeChain(table),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    return {
      data: [
        {
          result: scenario.commandResult,
          appointment_id:
            scenario.commandResult === "created" ? APPT_ID : null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    };
  },
};

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => admin }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitPublicBooking: async () => ({ allowed: true }),
  limitPublicSlots: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: () => "https://studio.example.test",
}));
vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => ({
    id: STUDIO_ID,
    slug: SLUG,
    name: "Contract Studio",
    owner_email: "owner@studio.test",
    timezone: "America/Toronto",
    default_appointment_duration_minutes: 45,
    buffer_minutes: 0,
    public_booking_horizon_months: 6,
    send_confirmation_emails: true,
    show_treatment_time_to_clients: false,
    notify_practitioner_on_new_booking: false,
  }),
}));
vi.mock("@/lib/booking/slots", () => ({
  getAvailableSlots: async () => [
    { start: START_ISO, end: new Date(START.getTime() + 45 * 60_000).toISOString() },
  ],
  filterFutureSlots: (s: unknown[]) => s,
}));
vi.mock("@/lib/booking/readiness", () => ({
  isPubliclyBookable: () => true,
  UNAVAILABLE_PUBLIC_BOOKING_MESSAGE: "unavailable",
}));
vi.mock("@/lib/booking/horizon", () => ({
  isWithinPublicBookingHorizon: () => true,
  horizonRangeInStudioTz: () => ({ min: "2020-01-01", max: "2030-01-01" }),
  maxPublicBookingHorizonDays: () => 400,
}));
vi.mock("@/lib/intake/queries", () => ({
  ensureIntakeForClient: async (p: unknown) => {
    intakeCalls.push(p);
    return { id: "intake-1", url: "https://studio.example.test/intake/abc" };
  },
}));
vi.mock("@/lib/treatment-time/queries", () => ({
  buildTreatmentTimeLine: () => null,
  getTreatmentTimeContextForEmail: async () => ({ sessionCount: 0, totalMinutes: 0 }),
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: async (p: unknown) => {
    confirmationEmails.push(p);
    return { ok: true };
  },
  sendBookingNotificationToPractitioner: async (p: unknown) => {
    practitionerEmails.push(p);
    return { ok: true };
  },
  recordEmailAttempt: async () => {},
  logEmailFailure: () => {},
}));
vi.mock("@/lib/sms/send-appointment", () => ({
  sendBookingConfirmationSmsToClient: async (p: unknown) => {
    smsCalls.push(p);
    return { ok: false, skipped: true };
  },
}));
vi.mock("@/lib/conversion/dispatch", () => ({
  dispatchBookingConversion: async (p: unknown) => { conversions.push(p); },
}));
vi.mock("@/lib/analytics/server", () => ({
  captureServerEvent: (p: unknown) => { analyticsEvents.push(p); },
}));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: (p: unknown) => {
    practitionerNotifications.push(p);
  },
}));

const { publicBookAppointmentAction } = await import("@/app/book/[slug]/actions");

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("slug", SLUG);
  fd.set("service_id", SERVICE_ID);
  fd.set("starts_at", START_ISO);
  fd.set("name", "Submitting Person");
  fd.set("email", UNKNOWN_EMAIL);
  fd.set("phone", "+15550111");
  fd.set("client_type", "new");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

function boundClientId(): unknown {
  return rpcCalls.find((c) => c.fn === "create_public_appointment")?.args
    .p_client_id;
}

function expectNothingMutated() {
  expect(dbWrites, "no row may be written").toEqual([]);
  expect(rpcCalls, "no appointment command may be issued").toEqual([]);
  expect(intakeCalls, "no intake may be created").toEqual([]);
  expect(confirmationEmails, "no confirmation may be sent").toEqual([]);
  expect(practitionerEmails, "no practitioner email may be sent").toEqual([]);
  expect(smsCalls, "no SMS may be sent").toEqual([]);
  expect(conversions, "no conversion may be dispatched").toEqual([]);
  expect(practitionerNotifications).toEqual([]);
  expect(analyticsEvents).toEqual([]);
}

beforeEach(() => {
  resetTripwires();
  scenario.activeClient = null;
  scenario.insertOutcome = "ok";
  scenario.commandResult = "created";
});

// ===========================================================================
// C1 — SPOOFED KNOWN EMAIL.  *** KNOWN GAP — RED BY DESIGN ***
// ===========================================================================
describe("SEC-01A C1 — spoofed known email [KNOWN GAP]", () => {
  // WHAT IS WRONG: typing a real client's address is sufficient to attach a
  // real appointment to that person's clinical record. No possession of the
  // address is proven at any point.
  //
  // WHY IT IS ASSERTED AS-IS: the assertion below states the DEFECT
  // (p_client_id is the victim's row). When possession proof lands, this test
  // MUST fail -- that is how the contract reports the gap closing. Do not
  // relax it to `expect.anything()`.
  //
  // TO EARN A GREEN HERE: the identity-possession model. Out of scope.
  it("binds the appointment to the victim's clinical identity from typed email alone", async () => {
    scenario.activeClient = ACTIVE_CLIENT;
    const res = await publicBookAppointmentAction(
      form({ client_type: "existing", email: VICTIM_EMAIL, name: "Attacker" }),
    );

    expect(res.ok, "the spoofed booking currently SUCCEEDS").toBe(true);
    expect(
      boundClientId(),
      "KNOWN GAP: bound to the victim's client row with no possession proof",
    ).toBe(EXISTING_CLIENT_ID);
  });

  it("no possession/verification step is invoked anywhere on the path", async () => {
    scenario.activeClient = ACTIVE_CLIENT;
    await publicBookAppointmentAction(
      form({ client_type: "existing", email: VICTIM_EMAIL }),
    );
    const fns = rpcCalls.map((c) => c.fn);
    expect(
      fns.filter((f) => /verif|claim|possess|otp|magic/i.test(f)),
      "KNOWN GAP: nothing on this path proves the submitter owns the address",
    ).toEqual([]);
  });

  it("client_type=new ALSO binds to a colliding active identity", async () => {
    // The `if (existingClient)` branch is not gated on clientType, so a
    // visitor who says "I am new" is still silently attached to whoever owns
    // that address. Same root cause, separate entry point.
    scenario.activeClient = ACTIVE_CLIENT;
    const res = await publicBookAppointmentAction(
      form({ client_type: "new", email: VICTIM_EMAIL }),
    );
    expect(res.ok).toBe(true);
    expect(
      boundClientId(),
      "KNOWN GAP: a self-declared NEW client was bound to an existing record",
    ).toBe(EXISTING_CLIENT_ID);
    expect(
      dbWrites.filter((w) => w.table === "clients"),
      "and no new client row was created for them",
    ).toEqual([]);
  });
});

// ===========================================================================
// C2 — UNKNOWN EMAIL.  PASS CONTRACT.
// ===========================================================================
describe("SEC-01A C2 — unknown email", () => {
  it("existing-client claim with no active match is refused and mutates NOTHING", async () => {
    scenario.activeClient = null;
    const res = await publicBookAppointmentAction(
      form({ client_type: "existing", email: UNKNOWN_EMAIL }),
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/couldn't match this as an existing client/i);
    expectNothingMutated();
  });

  it("a genuinely new client is created and booked", async () => {
    scenario.activeClient = null;
    const res = await publicBookAppointmentAction(
      form({ client_type: "new", email: UNKNOWN_EMAIL }),
    );
    expect(res.ok).toBe(true);
    expect(dbWrites).toContainEqual({ table: "clients", op: "insert" });
    expect(boundClientId()).toBe(CREATED_CLIENT_ID);
  });
});

// ===========================================================================
// C3 — ARCHIVED CLIENT.  PASS CONTRACT.
// ===========================================================================
describe("SEC-01A C3 — archived client", () => {
  it("an archived row is NEVER bound and no appointment is created", async () => {
    scenario.activeClient = null; // archived rows are excluded from the lookup
    scenario.insertOutcome = "conflict_archived";
    const res = await publicBookAppointmentAction(
      form({ client_type: "new", email: ARCHIVED_EMAIL }),
    );
    expect(res.ok).toBe(false);
    expect(
      rpcCalls.map((c) => c.fn),
      "the booking command must never run for an archived collision",
    ).not.toContain("create_public_appointment");
    expect(confirmationEmails).toEqual([]);
    expect(smsCalls).toEqual([]);
  });

  it("the archived path is never auto-unarchived or updated", async () => {
    scenario.activeClient = null;
    scenario.insertOutcome = "conflict_archived";
    await publicBookAppointmentAction(
      form({ client_type: "new", email: ARCHIVED_EMAIL }),
    );
    expect(
      dbWrites.filter((w) => w.table === "clients" && w.op !== "insert"),
      "no update/upsert may touch the archived row",
    ).toEqual([]);
  });

  it("an archived email on the EXISTING path is refused like any unknown address", async () => {
    scenario.activeClient = null;
    const res = await publicBookAppointmentAction(
      form({ client_type: "existing", email: ARCHIVED_EMAIL }),
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/couldn't match this as an existing client/i);
    expectNothingMutated();
  });
});

// ===========================================================================
// C4 — EXISTING CLIENT (LEGITIMATE).  PASS CONTRACT.
// ===========================================================================
describe("SEC-01A C4 — existing client, legitimate rebooking", () => {
  it("books against the client on file without mutating their record", async () => {
    scenario.activeClient = ACTIVE_CLIENT;
    const res = await publicBookAppointmentAction(
      form({ client_type: "existing", email: VICTIM_EMAIL, phone: "+15559999" }),
    );
    expect(res.ok).toBe(true);
    expect(boundClientId()).toBe(EXISTING_CLIENT_ID);
    // The submitted name/phone must never be written back onto the record:
    // that is how a public form would otherwise inject data into someone
    // else's chart.
    expect(
      dbWrites.filter((w) => w.table === "clients"),
      "an unauthenticated booking may not write to the clients table",
    ).toEqual([]);
  });

  it("a submitted phone that does not match the stored one cannot stamp SMS consent", async () => {
    scenario.activeClient = ACTIVE_CLIENT;
    await publicBookAppointmentAction(
      form({
        client_type: "existing",
        email: VICTIM_EMAIL,
        phone: "+15557777",
        sms_consent: "on",
      }),
    );
    expect(
      dbWrites.filter((w) => w.table === "clients" && w.op === "update"),
      "consent may not be stamped from a stranger's phone number",
    ).toEqual([]);
  });
});

// ===========================================================================
// C5 — ENUMERATION-EQUIVALENT RESPONSE BEHAVIOUR.
//      One half PASSES (and is newly enforced). One half is a KNOWN GAP.
// ===========================================================================
describe("SEC-01A C5 — enumeration-equivalent response behaviour", () => {
  async function errorFor(
    outcome: typeof scenario.insertOutcome,
    email: string,
  ): Promise<string> {
    resetTripwires();
    scenario.activeClient = null;
    scenario.insertOutcome = outcome;
    const res = await publicBookAppointmentAction(
      form({ client_type: "new", email }),
    );
    expect(res.ok).toBe(false);
    return res.ok === false ? res.error : "";
  }

  // PASS. The three outcomes of the same client INSERT are now one string, so
  // "this address belongs to an archived client" has no response signature.
  it("archived collision is byte-identical to an unresolved race", async () => {
    const archived = await errorFor("conflict_archived", ARCHIVED_EMAIL);
    const race = await errorFor("error", UNKNOWN_EMAIL);
    expect(archived).toBe(race);
  });

  it("archived collision reveals neither the archive nor the studio name", async () => {
    const archived = await errorFor("conflict_archived", ARCHIVED_EMAIL);
    expect(archived).not.toMatch(/archiv/i);
    expect(archived).not.toMatch(/different email/i);
    expect(archived).not.toMatch(/Contract Studio/);
  });

  // KNOWN GAP. Distinguishing an active client from an unknown address is
  // still trivially possible: one succeeds, the other returns a refusal.
  //
  // TO EARN A GREEN HERE: the existing-client path must stop answering
  // "matched / did not match" synchronously, which means the possession
  // model. Out of scope. Asserted as the DIVERGENCE it is.
  it("[KNOWN GAP] active vs unknown are still distinguishable on the existing path", async () => {
    resetTripwires();
    scenario.activeClient = ACTIVE_CLIENT;
    const hit = await publicBookAppointmentAction(
      form({ client_type: "existing", email: VICTIM_EMAIL }),
    );

    resetTripwires();
    scenario.activeClient = null;
    const miss = await publicBookAppointmentAction(
      form({ client_type: "existing", email: UNKNOWN_EMAIL }),
    );

    expect(
      hit.ok !== miss.ok,
      "KNOWN GAP: success-vs-refusal is an active-client existence oracle",
    ).toBe(true);
  });

  it("[KNOWN GAP] no timing normalisation exists to blunt that oracle", async () => {
    // The refusal returns before the booking command; the match runs the whole
    // pipeline. Recorded as an observable asymmetry in work performed, which
    // is the durable form of the timing signal.
    resetTripwires();
    scenario.activeClient = null;
    await publicBookAppointmentAction(
      form({ client_type: "existing", email: UNKNOWN_EMAIL }),
    );
    const missWork = rpcCalls.length + dbWrites.length;

    resetTripwires();
    scenario.activeClient = ACTIVE_CLIENT;
    await publicBookAppointmentAction(
      form({ client_type: "existing", email: VICTIM_EMAIL }),
    );
    const hitWork = rpcCalls.length + dbWrites.length;

    expect(
      hitWork > missWork,
      "KNOWN GAP: a match does strictly more work than a miss",
    ).toBe(true);
  });
});

// ===========================================================================
// C6 / C7 — DUPLICATE SUBMIT AND REPLAY.  PASS CONTRACT.
// ===========================================================================
describe("SEC-01A C6 — duplicate submit", () => {
  it("the second submission for the same slot is refused and creates nothing", async () => {
    scenario.activeClient = ACTIVE_CLIENT;
    const first = await publicBookAppointmentAction(
      form({ client_type: "existing", email: VICTIM_EMAIL }),
    );
    expect(first.ok).toBe(true);

    resetTripwires();
    scenario.commandResult = "time_unavailable"; // the slot is now taken
    const second = await publicBookAppointmentAction(
      form({ client_type: "existing", email: VICTIM_EMAIL }),
    );
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.code).toBe("slot_taken");
    expect(confirmationEmails, "a refused duplicate sends no confirmation").toEqual([]);
    expect(smsCalls).toEqual([]);
    expect(conversions).toEqual([]);
  });
});

describe("SEC-01A C7 — replay of a committed booking", () => {
  it("replaying the identical form cannot produce a second appointment", async () => {
    scenario.activeClient = ACTIVE_CLIENT;
    const fd = form({ client_type: "existing", email: VICTIM_EMAIL });
    const first = await publicBookAppointmentAction(fd);
    expect(first.ok).toBe(true);

    resetTripwires();
    scenario.commandResult = "not_a_public_slot";
    const replay = await publicBookAppointmentAction(fd);
    expect(replay.ok).toBe(false);
    expect(replay.ok === false && replay.code).toBe("slot_taken");
  });

  it("refusal is decided by the command, not by a client-supplied token", async () => {
    // There is no idempotency key on this surface: replay safety comes from
    // the command's own slot authority. Pinned so a future refactor cannot
    // move the decision into a forgeable request field.
    scenario.activeClient = ACTIVE_CLIENT;
    await publicBookAppointmentAction(
      form({ client_type: "existing", email: VICTIM_EMAIL }),
    );
    const args = rpcCalls[0]?.args ?? {};
    expect(Object.keys(args)).not.toContain("p_idempotency_key");
    expect(Object.keys(args)).toEqual(
      expect.arrayContaining(["p_studio_id", "p_client_id", "p_starts_at"]),
    );
  });
});

// ===========================================================================
// C8 — CONCURRENT DUPLICATE SUBMIT.  PASS CONTRACT.
// ===========================================================================
describe("SEC-01A C8 — concurrent duplicate submit", () => {
  it("a lost unique-index race resolves to the winner, never a second client", async () => {
    scenario.activeClient = null;      // both racers saw no active row
    scenario.insertOutcome = "conflict_active";
    const res = await publicBookAppointmentAction(
      form({ client_type: "new", email: VICTIM_EMAIL }),
    );
    expect(res.ok).toBe(true);
    expect(
      boundClientId(),
      "the loser binds to the winning row rather than duplicating it",
    ).toBe(EXISTING_CLIENT_ID);
    expect(
      dbWrites.filter((w) => w.table === "clients" && w.op === "insert"),
      "exactly one INSERT was attempted, and it lost",
    ).toHaveLength(1);
  });

  it("an unresolvable race refuses rather than guessing an identity", async () => {
    scenario.activeClient = null;
    scenario.insertOutcome = "error";
    const res = await publicBookAppointmentAction(
      form({ client_type: "new", email: UNKNOWN_EMAIL }),
    );
    expect(res.ok).toBe(false);
    expect(rpcCalls.map((c) => c.fn)).not.toContain("create_public_appointment");
  });
});

// ===========================================================================
// C9 — EMAIL NORMALISATION.  PASS CONTRACT.
// ===========================================================================
describe("SEC-01A C9 — email normalisation", () => {
  it("casing and surrounding whitespace resolve to one identity", async () => {
    scenario.activeClient = ACTIVE_CLIENT;
    await publicBookAppointmentAction(
      form({ client_type: "existing", email: `  ${VICTIM_EMAIL.toUpperCase()}  ` }),
    );
    expect(
      clientLookups.map((l) => l.normalizedEmail),
      "the lookup key must match the normalized_email column rule, lower(trim())",
    ).toContain(VICTIM_EMAIL);
  });
});

// ===========================================================================
// C10 — CROSS-STUDIO IDENTITY.  PASS CONTRACT.
// ===========================================================================
describe("SEC-01A C10 — cross-studio identity", () => {
  it("every identity lookup is scoped to the SERVER-resolved studio", async () => {
    scenario.activeClient = ACTIVE_CLIENT;
    await publicBookAppointmentAction(
      form({ client_type: "existing", email: VICTIM_EMAIL, slug: "some-other-slug" }),
    );
    expect(clientLookups.length).toBeGreaterThan(0);
    for (const l of clientLookups) {
      expect(l.studioId, "never an unscoped or browser-chosen tenant").toBe(STUDIO_ID);
      expect(l.studioId).not.toBe(OTHER_STUDIO_ID);
    }
  });

  it("the booking command is issued for that same studio", async () => {
    scenario.activeClient = ACTIVE_CLIENT;
    await publicBookAppointmentAction(
      form({ client_type: "existing", email: VICTIM_EMAIL }),
    );
    expect(rpcCalls[0]?.args.p_studio_id).toBe(STUDIO_ID);
  });
});
