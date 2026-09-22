import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEW_CLIENT_WAITLIST_SLUGS_ENV } from "@/lib/booking/new-client-waitlist";
import { addDays, todayInTz } from "@/lib/booking/tz";
import {
  PORTAL_REBOOK_GENERIC_REFUSAL,
  PORTAL_REBOOK_SERVICE_UNAVAILABLE,
  PORTAL_REBOOK_SESSION_EXPIRED,
  PORTAL_REBOOK_SLOT_TAKEN,
} from "@/lib/portal/rebook-copy";

// ===========================================================================
// EMERG-PORTAL-REBOOK-01 — the portal rebooking contract, driven for real.
// ===========================================================================
//
// This drives the REAL `bookAnotherAppointmentAction`. Nothing about the
// identity path is stubbed out: the fake Supabase client below honours every
// `.eq()` filter the action applies, so "the client lookup is scoped to the
// session's studio" is a claim the fake can FALSIFY rather than one it agrees
// with by construction. A cross-studio service really is absent from the
// services table; an archived client really does come back with
// `archived_at` set.
//
// The real `filterFutureSlots`, the real horizon module, the real token
// helpers and the real refusal copy are all used. The only things replaced are
// the network edges: Supabase, the email/notification senders, intake, and the
// app origin.

const SESSION_STUDIO = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDIO = "22222222-2222-4222-8222-222222222222";
const SESSION_CLIENT = "33333333-3333-4333-8333-333333333333";
const FORGED_CLIENT = "44444444-4444-4444-8444-444444444444";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_STUDIO_SERVICE = "66666666-6666-4666-8666-666666666666";
const INACTIVE_SERVICE = "77777777-7777-4777-8777-777777777777";
const PRACTITIONER_ID = "88888888-8888-4888-8888-888888888888";
const APPOINTMENT_ID = "99999999-9999-4999-8999-999999999999";
const SLUG = "waitlisted-studio";

// Ten days out, on a whole minute. Future (so the real past-time guard and the
// real `filterFutureSlots` both pass it) and inside a 3-month horizon (so the
// real horizon module admits it) no matter when the suite runs.
const START = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
START.setUTCSeconds(0, 0);
const START_ISO = START.toISOString();

type Session = { id: string; studioId: string; clientId: string; expiresAt: string };

/** Every read the action performed, with the filters it actually applied. */
type Read = { table: string; filters: Record<string, unknown> };
/** Every command the action issued, with the arguments it actually sent. */
type Rpc = { fn: string; args: Record<string, unknown> };

const reads: Read[] = [];
const rpcs: Rpc[] = [];
const emails: Array<{ kind: string; to: string }> = [];
const notifications: Array<{ clientId: string; appointmentId: string }> = [];
/** Every date string handed to the slot generator, as the action derived it. */
const slotCalls: Array<{ dateStr: string; durationMinutes: number }> = [];
const smsCalls: Array<{
  appointmentId: string;
  phone: string | null;
  consentAt: string | null;
  optedOutAt: string | null;
}> = [];
/** Post-commit effects that should throw, to prove containment. */
const throwIn = new Set<string>();
const revalidated: string[] = [];

const scenario = {
  session: {
    id: "session-1",
    studioId: SESSION_STUDIO,
    clientId: SESSION_CLIENT,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  } as Session | null,
  clientArchived: false,
  timezone: "UTC",
  clientEmail: "returning@example.test" as string | null,
  clientPhone: "+15550100" as string | null,
  smsConsentAt: null as string | null,
  smsOptedOutAt: null as string | null,
  /** The raw generator output, BEFORE the action's own public filters. */
  generatedSlots: null as Array<{ start: string; end: string; startLabel: string }> | null,
  clientReadError: null as { code: string } | null,
  studioReadError: null as { code: string } | null,
  studioMissing: false,
  sendConfirmationEmails: true,
  notifyPractitioner: true,
  serviceReadError: null as { code: string } | null,
  slotOffered: true,
  commandResult: "created" as string | null,
  commandError: null as { code: string } | null,
  suppressAppointmentId: false,
  confirmationEmailOk: true,
};

/** The services table, as rows with real tenancy + active columns. */
const SERVICE_ROWS = [
  {
    id: SERVICE_ID,
    studio_id: SESSION_STUDIO,
    name: "Follow-up treatment",
    modality: "electrolysis",
    default_duration_minutes: 45,
    active: true,
  },
  {
    id: INACTIVE_SERVICE,
    studio_id: SESSION_STUDIO,
    name: "Retired treatment",
    modality: "electrolysis",
    default_duration_minutes: 45,
    active: false,
  },
  {
    id: OTHER_STUDIO_SERVICE,
    studio_id: OTHER_STUDIO,
    name: "Another studio's service",
    modality: "electrolysis",
    default_duration_minutes: 45,
    active: true,
  },
];

function resolveRow(table: string, f: Record<string, unknown>) {
  if (table === "clients") {
    if (scenario.clientReadError) return { data: null, error: scenario.clientReadError };
    // Tenancy is HONOURED, not assumed: a client id that does not sit under the
    // requested studio_id is simply not here.
    if (f.id !== SESSION_CLIENT || f.studio_id !== SESSION_STUDIO) {
      return { data: null, error: null };
    }
    return {
      data: {
        id: SESSION_CLIENT,
        name: "Returning Client",
        email: scenario.clientEmail,
        phone: scenario.clientPhone,
        sms_consent_at: scenario.smsConsentAt,
        sms_opted_out_at: scenario.smsOptedOutAt,
        archived_at: scenario.clientArchived ? new Date().toISOString() : null,
      },
      error: null,
    };
  }
  if (table === "studios") {
    if (scenario.studioReadError) return { data: null, error: scenario.studioReadError };
    if (scenario.studioMissing || f.id !== SESSION_STUDIO) {
      return { data: null, error: null };
    }
    return {
      data: {
        id: SESSION_STUDIO,
        slug: SLUG,
        name: "Willow Studio",
        owner_email: "owner@studio.test",
        timezone: scenario.timezone,
        default_appointment_duration_minutes: 45,
        buffer_minutes: 0,
        public_booking_horizon_months: 3,
        send_confirmation_emails: scenario.sendConfirmationEmails,
        show_treatment_time_to_clients: false,
        notify_practitioner_on_new_booking: scenario.notifyPractitioner,
      },
      error: null,
    };
  }
  if (table === "services") {
    if (scenario.serviceReadError) return { data: null, error: scenario.serviceReadError };
    // The shared loader reads a LIST scoped by studio_id + active; tenancy and
    // activeness are honoured here rather than assumed, so a cross-studio id is
    // genuinely absent from what the action receives.
    const rows = SERVICE_ROWS.filter(
      (s) =>
        s.studio_id === f.studio_id &&
        (f.active === undefined || s.active === f.active) &&
        (f.id === undefined || s.id === f.id),
    );
    return { data: rows, error: null, rows };
  }
  if (table === "practitioners") {
    if (f.id !== PRACTITIONER_ID || f.studio_id !== SESSION_STUDIO) {
      return { data: null, error: null };
    }
    return {
      data: {
        id: PRACTITIONER_ID,
        display_name: "Chloe",
        email: "chloe@studio.test",
      },
      error: null,
    };
  }
  return { data: null, error: null };
}

function makeChain(table: string) {
  const filters: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  const self = () => chain as never;
  Object.assign(chain, {
    select: self,
    order: self,
    limit: self,
    is: (col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    },
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    },
    maybeSingle: async () => {
      reads.push({ table, filters: { ...filters } });
      return resolveRow(table, filters);
    },
    single: async () => {
      reads.push({ table, filters: { ...filters } });
      return resolveRow(table, filters);
    },
    insert: () => {
      throw new Error(`unexpected direct insert into ${table}`);
    },
    update: self,
    then: (resolve: (v: unknown) => unknown) => {
      reads.push({ table, filters: { ...filters } });
      const r = resolveRow(table, filters) as { data: unknown; error: unknown };
      return Promise.resolve({
        data: Array.isArray(r.data) ? r.data : r.data ? [r.data] : [],
        error: r.error,
      }).then(resolve);
    },
  });
  return chain;
}

const admin = {
  from: (table: string) => makeChain(table),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpcs.push({ fn, args });
    if (fn !== "create_public_appointment") return { data: null, error: null };
    if (scenario.commandError) return { data: null, error: scenario.commandError };
    const created = scenario.commandResult === "created";
    return {
      data: [
        {
          result: scenario.commandResult,
          appointment_id:
            created && !scenario.suppressAppointmentId ? APPOINTMENT_ID : null,
          starts_at: START_ISO,
          ends_at: new Date(START.getTime() + 45 * 60_000).toISOString(),
          duration_minutes: 45,
          practitioner_id: PRACTITIONER_ID,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    };
  },
};

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/portal/session", () => ({
  getCurrentPortalSession: async () => scenario.session,
}));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
    if (throwIn.has("revalidate")) throw new TypeError("outside request scope");
  },
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: () => "https://studio.example.test",
}));
// The REAL filterFutureSlots is kept; only the day loader is replaced.
vi.mock("@/lib/booking/slots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking/slots")>();
  return {
    ...actual,
    getAvailableSlots: async (
      _admin: unknown,
      _studio: unknown,
      dateStr: string,
      durationMinutes: number,
    ) => {
      slotCalls.push({ dateStr, durationMinutes });
      // `generatedSlots` models the RAW generator output when a test needs to
      // prove the action's own public filters, rather than the fake, are what
      // removes a start.
      if (scenario.generatedSlots) return scenario.generatedSlots;
      return scenario.slotOffered
        ? [
            {
              start: START_ISO,
              end: new Date(START.getTime() + 45 * 60_000).toISOString(),
              startLabel: "10:00 AM",
            },
          ]
        : [];
    },
  };
});
vi.mock("@/lib/sms/send-appointment", () => ({
  sendBookingConfirmationSmsToClient: async (p: {
    appointmentId: string;
    client: { phone: string | null; sms_consent_at: string | null; sms_opted_out_at: string | null };
  }) => {
    if (throwIn.has("sms")) throw new TypeError("sms blew up");
    smsCalls.push({
      appointmentId: p.appointmentId,
      phone: p.client.phone,
      consentAt: p.client.sms_consent_at,
      optedOutAt: p.client.sms_opted_out_at,
    });
    return { ok: true };
  },
}));
vi.mock("@/lib/intake/queries", () => ({
  ensureIntakeForClient: async () => {
    if (throwIn.has("intake")) throw new TypeError("intake blew up");
    return { id: "intake-1", url: "https://studio.example.test/intake/abc" };
  },
}));
vi.mock("@/lib/treatment-time/queries", () => ({
  buildTreatmentTimeLine: () => null,
  getTreatmentTimeContextForEmail: async () => ({ sessionCount: 0, totalMinutes: 0 }),
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: async (p: { clientEmail: string }) => {
    if (throwIn.has("confirmation_email")) throw new TypeError("sender blew up");
    emails.push({ kind: "client_confirmation", to: p.clientEmail });
    return scenario.confirmationEmailOk
      ? { ok: true }
      : { ok: false, error: "provider refused", retryable: true };
  },
  sendBookingNotificationToPractitioner: async (p: { practitionerEmail: string }) => {
    if (throwIn.has("practitioner_email")) throw new TypeError("sender blew up");
    emails.push({ kind: "practitioner_notification", to: p.practitionerEmail });
    return { ok: true };
  },
  recordEmailAttempt: async () => {
    if (throwIn.has("email_attempt")) throw new TypeError("bookkeeping blew up");
  },
  logEmailFailure: () => {},
}));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: (p: { clientId: string; appointmentId: string }) => {
    if (throwIn.has("practitioner_notification")) throw new TypeError("notify blew up");
    notifications.push({ clientId: p.clientId, appointmentId: p.appointmentId });
  },
}));

const { bookAnotherAppointmentAction, loadPortalRebookSlotsAction } = await import(
  "@/app/portal/rebook-actions"
);

/** The booking form. `over` adds forged fields; it never removes a real one. */
function form(over: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("serviceId", SERVICE_ID);
  fd.set("startsAt", START_ISO);
  for (const [k, v] of Object.entries(over)) {
    if (v === "") fd.delete(k);
    else fd.set(k, v);
  }
  return fd;
}

const commits = () => rpcs.filter((r) => r.fn === "create_public_appointment");

beforeEach(() => {
  reads.length = 0;
  rpcs.length = 0;
  emails.length = 0;
  notifications.length = 0;
  slotCalls.length = 0;
  smsCalls.length = 0;
  revalidated.length = 0;
  throwIn.clear();
  delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
  Object.assign(scenario, {
    session: {
      id: "session-1",
      studioId: SESSION_STUDIO,
      clientId: SESSION_CLIENT,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    clientArchived: false,
    timezone: "UTC",
    clientEmail: "returning@example.test",
    clientPhone: "+15550100",
    smsConsentAt: null,
    smsOptedOutAt: null,
    generatedSlots: null,
    clientReadError: null,
    studioReadError: null,
    studioMissing: false,
    sendConfirmationEmails: true,
    notifyPractitioner: true,
    serviceReadError: null,
    slotOffered: true,
    commandResult: "created",
    commandError: null,
    suppressAppointmentId: false,
    confirmationEmailOk: true,
  });
});

// ---------------------------------------------------------------------------
// A + B. The journey, and whose appointment it is.
// ---------------------------------------------------------------------------

describe("A. an authenticated portal client can book a new appointment", () => {
  it("commits through the canonical command and acknowledges truthfully", async () => {
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.appointmentId).toBe(APPOINTMENT_ID);
    expect(out.serviceName).toBe("Follow-up treatment");
    expect(out.startsAt).toBe(START_ISO);
    expect(out.manageUrl).toContain("https://studio.example.test/manage/");
    expect(commits()).toHaveLength(1);
  });

  it("uses create_public_appointment and NO other appointment writer", async () => {
    await bookAnotherAppointmentAction(form());
    // A direct `.insert()` on any table throws inside the fake, so reaching a
    // success at all proves nothing bypassed the command.
    expect(rpcs.map((r) => r.fn)).toEqual(["create_public_appointment"]);
  });

  it("carries the optional note into the existing p_notes contract", async () => {
    await bookAnotherAppointmentAction(form({ notes: "  Please use the lower room.  " }));
    expect(commits()[0].args.p_notes).toBe("Please use the lower room.");
  });

  it("sends an empty note as null rather than an empty string", async () => {
    await bookAnotherAppointmentAction(form({ notes: "   " }));
    expect(commits()[0].args.p_notes).toBeNull();
  });
});

describe("B. the appointment belongs to the EXACT session client", () => {
  it("binds p_client_id and p_studio_id from the session", async () => {
    await bookAnotherAppointmentAction(form());
    expect(commits()[0].args.p_client_id).toBe(SESSION_CLIENT);
    expect(commits()[0].args.p_studio_id).toBe(SESSION_STUDIO);
  });

  it("follows the session when the session names a different client", async () => {
    // NEGATIVE CONTROL for the assertion above: if the binding were a constant
    // or came from the form, moving the session would not move the booking.
    const otherClient = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    scenario.session = {
      id: "session-2",
      studioId: SESSION_STUDIO,
      clientId: otherClient,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const out = await bookAnotherAppointmentAction(form());
    // That client is not on file, so the booking is refused — and the lookup
    // that refused it asked for the SESSION's id, not the previous one.
    expect(out.ok).toBe(false);
    const clientRead = reads.find((r) => r.table === "clients");
    expect(clientRead?.filters.id).toBe(otherClient);
    expect(commits()).toHaveLength(0);
  });

  it("scopes the client lookup by the session studio AND the session client", async () => {
    await bookAnotherAppointmentAction(form());
    const clientRead = reads.find((r) => r.table === "clients");
    expect(clientRead?.filters).toMatchObject({
      id: SESSION_CLIENT,
      studio_id: SESSION_STUDIO,
    });
  });

  it("notifies the practitioner about the SESSION's client", async () => {
    await bookAnotherAppointmentAction(form());
    expect(notifications).toEqual([
      { clientId: SESSION_CLIENT, appointmentId: APPOINTMENT_ID },
    ]);
  });
});

// ---------------------------------------------------------------------------
// C. A forged browser identity changes nothing.
// ---------------------------------------------------------------------------

describe("C. a forged browser client identity is ignored", () => {
  const FORGERIES: Record<string, string> = {
    client_id: FORGED_CLIENT,
    clientId: FORGED_CLIENT,
    studio_id: OTHER_STUDIO,
    studioId: OTHER_STUDIO,
    email: "someone.else@example.test",
    name: "Someone Else",
    phone: "+15559999",
    client_type: "existing",
  };

  for (const [field, value] of Object.entries(FORGERIES)) {
    it(`ignores a submitted ${field}`, async () => {
      const out = await bookAnotherAppointmentAction(form({ [field]: value }));
      expect(out.ok).toBe(true);
      expect(commits()[0].args.p_client_id).toBe(SESSION_CLIENT);
      expect(commits()[0].args.p_studio_id).toBe(SESSION_STUDIO);
    });
  }

  it("ignores ALL of them at once", async () => {
    const out = await bookAnotherAppointmentAction(form(FORGERIES));
    expect(out.ok).toBe(true);
    expect(commits()[0].args.p_client_id).toBe(SESSION_CLIENT);
    expect(commits()[0].args.p_studio_id).toBe(SESSION_STUDIO);
    // And no read anywhere went looking for the forged identity.
    for (const r of reads) {
      expect(Object.values(r.filters)).not.toContain(FORGED_CLIENT);
      expect(Object.values(r.filters)).not.toContain(OTHER_STUDIO);
      expect(Object.values(r.filters)).not.toContain("someone.else@example.test");
    }
  });

  it("NON-VACUITY: the forged values are values the fake would have honoured", async () => {
    // If the action DID read a submitted client id, this fake would have
    // resolved it to "no such client" and the booking would have failed — so
    // the passing tests above are not passing because the forgeries are inert.
    const probe = resolveRowProbe("clients", {
      id: FORGED_CLIENT,
      studio_id: SESSION_STUDIO,
    });
    expect(probe.data).toBeNull();
  });
});

/** Direct access to the fake's resolver, for non-vacuity probes only. */
function resolveRowProbe(table: string, filters: Record<string, unknown>) {
  return resolveRow(table, filters);
}

// ---------------------------------------------------------------------------
// D. Cross-studio isolation.
// ---------------------------------------------------------------------------

describe("D. a portal client of studio A cannot book studio B", () => {
  it("refuses a service that belongs to another studio", async () => {
    const out = await bookAnotherAppointmentAction(
      form({ serviceId: OTHER_STUDIO_SERVICE }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("service_unavailable");
    expect(out.error).toBe(PORTAL_REBOOK_SERVICE_UNAVAILABLE);
    expect(commits()).toHaveLength(0);
  });

  it("asks the services table for the SESSION's studio, never the submitted one", async () => {
    await bookAnotherAppointmentAction(
      form({ serviceId: OTHER_STUDIO_SERVICE, studio_id: OTHER_STUDIO }),
    );
    const serviceRead = reads.find((r) => r.table === "services");
    expect(serviceRead?.filters.studio_id).toBe(SESSION_STUDIO);
    expect(serviceRead?.filters.active).toBe(true);
  });

  it("NON-VACUITY: the same service id IS bookable from its own studio's session", async () => {
    // Without this, "cross-studio is refused" could be passing because the
    // service id is simply unknown to the fake.
    scenario.session = {
      id: "session-b",
      studioId: OTHER_STUDIO,
      clientId: SESSION_CLIENT,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const serviceRead = resolveRowProbe("services", {
      id: OTHER_STUDIO_SERVICE,
      studio_id: OTHER_STUDIO,
      active: true,
    });
    expect(serviceRead.data as unknown[]).toHaveLength(1);
    // ...and it is ABSENT when asked for under the SESSION's studio, which is
    // what makes the cross-studio refusal above attributable to tenancy.
    expect(
      resolveRowProbe("services", {
        id: OTHER_STUDIO_SERVICE,
        studio_id: SESSION_STUDIO,
        active: true,
      }).data as unknown[],
    ).toHaveLength(0);
  });

  it("the slot loader is scoped to the session studio too", async () => {
    const out = await loadPortalRebookSlotsAction({
      serviceId: OTHER_STUDIO_SERVICE,
      date: START_ISO.slice(0, 10),
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("service_unavailable");
  });
});

// ---------------------------------------------------------------------------
// E. No session, no booking.
// ---------------------------------------------------------------------------

describe("E. a logged-out visitor cannot use the portal booking action", () => {
  it("refuses with session_expired and reads NOTHING", async () => {
    scenario.session = null;
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("session_expired");
    expect(out.error).toBe(PORTAL_REBOOK_SESSION_EXPIRED);
    // The refusal happens BEFORE any database work, so an anonymous caller
    // cannot even make this action touch a table.
    expect(reads).toHaveLength(0);
    expect(rpcs).toHaveLength(0);
  });

  it("refuses the slot loader too", async () => {
    scenario.session = null;
    const out = await loadPortalRebookSlotsAction({
      serviceId: SERVICE_ID,
      date: START_ISO.slice(0, 10),
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("session_expired");
    expect(reads).toHaveLength(0);
  });

  it("a forged identity does NOT rescue a missing session", async () => {
    scenario.session = null;
    const out = await bookAnotherAppointmentAction(
      form({ client_id: SESSION_CLIENT, studio_id: SESSION_STUDIO }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("session_expired");
    expect(rpcs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F + G. Archived client, inactive service.
// ---------------------------------------------------------------------------

describe("F. an archived client cannot book", () => {
  it("refuses, commits nothing, and does not say WHY", async () => {
    scenario.clientArchived = true;
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("unavailable");
    expect(out.error).toBe(PORTAL_REBOOK_GENERIC_REFUSAL);
    expect(out.error).not.toMatch(/archiv/i);
    expect(commits()).toHaveLength(0);
  });

  it("a DB read failure is refused the SAME way, and never as 'no availability'", async () => {
    scenario.clientReadError = { code: "57014" };
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("unavailable");
    expect(out.error).toBe(PORTAL_REBOOK_GENERIC_REFUSAL);
    expect(out.error).not.toMatch(/no (times|availability)/i);
    expect(commits()).toHaveLength(0);
  });

  it("an unreadable studio row is refused, not treated as a missing studio", async () => {
    scenario.studioReadError = { code: "57014" };
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("unavailable");
    expect(commits()).toHaveLength(0);
  });
});

describe("G. an inactive service is refused", () => {
  it("refuses before any command is issued", async () => {
    const out = await bookAnotherAppointmentAction(form({ serviceId: INACTIVE_SERVICE }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("service_unavailable");
    expect(commits()).toHaveLength(0);
  });

  it("NON-VACUITY: the same row IS returned when `active` is not required", async () => {
    // Proves the refusal comes from the `active` filter and not from the row
    // being absent altogether.
    expect(
      resolveRowProbe("services", {
        id: INACTIVE_SERVICE,
        studio_id: SESSION_STUDIO,
      }).data as unknown[],
    ).toHaveLength(1);
    expect(
      resolveRowProbe("services", {
        id: INACTIVE_SERVICE,
        studio_id: SESSION_STUDIO,
        active: true,
      }).data as unknown[],
    ).toHaveLength(0);
  });

  it("a service READ FAILURE is 'unavailable', not 'that service is gone'", async () => {
    scenario.serviceReadError = { code: "57014" };
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("unavailable");
    expect(commits()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H + I. The availability authority still decides.
// ---------------------------------------------------------------------------

describe("H. a stale or taken slot is refused", () => {
  it("refuses a start the public grid does not offer, before the command", async () => {
    scenario.slotOffered = false;
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("slot_taken");
    expect(out.error).toBe(PORTAL_REBOOK_SLOT_TAKEN);
    expect(commits()).toHaveLength(0);
  });

  it("refuses a start in the past", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const out = await bookAnotherAppointmentAction(form({ startsAt: past }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("slot_taken");
    expect(commits()).toHaveLength(0);
  });

  it("refuses a date beyond the studio's booking horizon", async () => {
    const farOut = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
    const out = await bookAnotherAppointmentAction(form({ startsAt: farOut }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("outside_window");
    expect(commits()).toHaveLength(0);
  });
});

describe("I. the command's availability refusals reach the client as 'pick another time'", () => {
  // The application's own slot re-check runs BEFORE the studio lock, so these
  // are the codes that arrive when the calendar moves underneath it. Every one
  // of them is a real rule the command enforces: overlap, buffer, blockout,
  // break, working hours, and exact grid membership.
  const SLOT_CODES = [
    "time_unavailable",
    "outside_availability",
    "studio_closed",
    "not_a_public_slot",
    "invalid_time",
  ];
  for (const code of SLOT_CODES) {
    it(`maps ${code} to slot_taken`, async () => {
      scenario.commandResult = code;
      const out = await bookAnotherAppointmentAction(form());
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("unreachable");
      expect(out.code).toBe("slot_taken");
    });
  }

  it("maps the overlap exclusion constraint (23P01) to slot_taken", async () => {
    scenario.commandError = { code: "23P01" };
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok === false && out.code).toBe("slot_taken");
  });

  it("maps the soft-buffer trigger (HB001) to slot_taken", async () => {
    scenario.commandError = { code: "HB001" };
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok === false && out.code).toBe("slot_taken");
  });

  it("never echoes a tenancy or eligibility code to the client", async () => {
    for (const code of [
      "invalid_client",
      "studio_not_found",
      "not_eligible",
      "public_booking_unavailable",
      "invalid_practitioner",
    ]) {
      scenario.commandResult = code;
      const out = await bookAnotherAppointmentAction(form());
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("unreachable");
      expect(out.code).toBe("unavailable");
      expect(out.error).not.toContain(code);
    }
  });

  it("a `created` with no appointment id is a refusal, never a success", async () => {
    scenario.suppressAppointmentId = true;
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// J. One press, one appointment.
// ---------------------------------------------------------------------------

describe("J. a second press cannot produce a second appointment", () => {
  it("the re-press is refused once the first booking has taken the slot", async () => {
    const first = await bookAnotherAppointmentAction(form());
    expect(first.ok).toBe(true);
    // The first booking is what removes the slot from the offered grid. This is
    // the state the second press meets.
    scenario.slotOffered = false;
    const second = await bookAnotherAppointmentAction(form());
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("slot_taken");
    expect(commits(), "exactly one appointment command for two presses").toHaveLength(1);
  });

  it("a concurrent press that gets past the grid is still refused by the command", async () => {
    // The pre-lock re-check can be stale by definition. This models the press
    // that slips through it and meets the exclusion constraint instead.
    await bookAnotherAppointmentAction(form());
    scenario.commandError = { code: "23P01" };
    const second = await bookAnotherAppointmentAction(form());
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("slot_taken");
  });
});

// ---------------------------------------------------------------------------
// K. WAIT gates new-client ADMISSION, never a returning client's authority.
// ---------------------------------------------------------------------------

describe("K. a WAIT-enabled studio still lets an authenticated returning client rebook", () => {
  it("books normally with the studio named in the waitlist env", async () => {
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = SLUG;
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok, "a returning client is not re-admitted, so WAIT cannot refuse them").toBe(true);
    expect(commits()).toHaveLength(1);
  });

  it("books normally with the studio named alongside others", async () => {
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = `some-other, ${SLUG} ,yet-another`;
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(true);
  });

  it("NON-VACUITY: the env value really is the one the gate reads", async () => {
    // If this env var were not the live admission switch, the two tests above
    // would prove nothing. `isNewClientWaitlistEnabled` is the reader, and it
    // says yes for this slug under exactly the value set above.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = SLUG;
    const { isNewClientWaitlistEnabled } = await import(
      "@/lib/booking/new-client-waitlist"
    );
    expect(isNewClientWaitlistEnabled(SLUG)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The post-commit law, and the truth of the acknowledgement.
// ---------------------------------------------------------------------------

describe("a committed booking survives every downstream failure", () => {
  it("reports `sent` only when the provider accepted", async () => {
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok && out.confirmationEmailStatus).toBe("sent");
    expect(emails).toContainEqual({
      kind: "client_confirmation",
      to: "returning@example.test",
    });
  });

  it("reports `failed` when the provider refused, and still succeeds", async () => {
    scenario.confirmationEmailOk = false;
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.confirmationEmailStatus).toBe("failed");
    expect(out.manageUrl).toContain("/manage/");
  });

  it("reports `disabled` when the studio switched confirmations off", async () => {
    scenario.sendConfirmationEmails = false;
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok && out.confirmationEmailStatus).toBe("disabled");
    expect(emails.filter((e) => e.kind === "client_confirmation")).toHaveLength(0);
  });

  it("reports `failed`, NOT `disabled`, when confirmations are on and no address is on file", async () => {
    scenario.clientEmail = null;
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(
      out.confirmationEmailStatus,
      "a studio that sends confirmations has not switched them off",
    ).toBe("failed");
    expect(out.confirmationEmail).toBeNull();
  });

  it("emails the address ON FILE, never one that was typed", async () => {
    await bookAnotherAppointmentAction(form({ email: "attacker@example.test" }));
    expect(emails.map((e) => e.to)).not.toContain("attacker@example.test");
    expect(emails).toContainEqual({
      kind: "client_confirmation",
      to: "returning@example.test",
    });
  });

  it("returns the address on file so the acknowledgement is checkable", async () => {
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok && out.confirmationEmail).toBe("returning@example.test");
  });

  it("honours the practitioner notification toggle", async () => {
    scenario.notifyPractitioner = false;
    await bookAnotherAppointmentAction(form());
    expect(emails.filter((e) => e.kind === "practitioner_notification")).toHaveLength(0);
  });

  it("notifies the AUTHORITATIVE assigned practitioner when the toggle is on", async () => {
    await bookAnotherAppointmentAction(form());
    expect(emails).toContainEqual({
      kind: "practitioner_notification",
      to: "chloe@studio.test",
    });
  });
});

describe("the command never receives a parameter it must not receive", () => {
  it("sends exactly the seven server-prepared arguments", async () => {
    await bookAnotherAppointmentAction(form({ notes: "hello" }));
    expect(Object.keys(commits()[0].args).sort()).toEqual([
      "p_cancellation_token_hash",
      "p_client_id",
      "p_notes",
      "p_referral_source",
      "p_service_id",
      "p_starts_at",
      "p_studio_id",
    ]);
  });

  it("persists only the HASH of the management token", async () => {
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    const hash = commits()[0].args.p_cancellation_token_hash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const raw = out.manageUrl.split("/manage/")[1];
    expect(raw.length).toBeGreaterThan(0);
    expect(hash).not.toContain(raw);
  });

  it("sends a millisecond-precise start, which the command requires", async () => {
    await bookAnotherAppointmentAction(form());
    const sent = commits()[0].args.p_starts_at as string;
    expect(new Date(sent).toISOString()).toBe(sent);
    expect(sent).toBe(START_ISO);
  });
});

// ---------------------------------------------------------------------------
// P2-1. The offered set is the set the public contract would accept.
// ---------------------------------------------------------------------------

describe("P2-1. only slots the public contract would accept are offered", () => {
  const today = () => todayInTz(scenario.timezone);

  /** A raw generator answer containing one elapsed start and one future one. */
  function pastAndFuture() {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    past.setUTCSeconds(0, 0);
    const soon = new Date(Date.now() + 3 * 60 * 60 * 1000);
    soon.setUTCSeconds(0, 0);
    return {
      past: past.toISOString(),
      soon: soon.toISOString(),
      slots: [
        { start: past.toISOString(), end: past.toISOString(), startLabel: "past" },
        { start: soon.toISOString(), end: soon.toISOString(), startLabel: "soon" },
      ],
    };
  }

  it("never offers a start that has already elapsed today", async () => {
    const { past, slots } = pastAndFuture();
    scenario.generatedSlots = slots;
    const out = await loadPortalRebookSlotsAction({
      serviceId: SERVICE_ID,
      date: today(),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.slots.map((s) => s.start)).not.toContain(past);
  });

  it("DOES offer a still-future start on the same day", async () => {
    // NON-VACUITY for the rule above: the filter removes the elapsed start and
    // nothing else, so "no past slots" is not passing by returning nothing.
    const { soon, slots } = pastAndFuture();
    scenario.generatedSlots = slots;
    const out = await loadPortalRebookSlotsAction({
      serviceId: SERVICE_ID,
      date: today(),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.slots.map((s) => s.start)).toContain(soon);
    expect(out.slots).toHaveLength(1);
  });

  it("serves a date INSIDE the public booking horizon", async () => {
    const out = await loadPortalRebookSlotsAction({
      serviceId: SERVICE_ID,
      date: addDays(today(), 30),
    });
    expect(out.ok).toBe(true);
    expect(slotCalls).toHaveLength(1);
  });

  it("refuses a date BEYOND the horizon, before generating anything", async () => {
    // A forged or hand-edited date must be refused before any offerable slot is
    // returned — the studio's horizon is 3 months, i.e. 93 days.
    const out = await loadPortalRebookSlotsAction({
      serviceId: SERVICE_ID,
      date: addDays(today(), 200),
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("outside_window");
    expect(slotCalls, "no generation may happen for an out-of-window date").toHaveLength(0);
  });

  it("refuses a date BEFORE today", async () => {
    const out = await loadPortalRebookSlotsAction({
      serviceId: SERVICE_ID,
      date: addDays(today(), -1),
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("outside_window");
    expect(slotCalls).toHaveLength(0);
  });

  it("a stale pick still fails at SUBMISSION, not only in the list", async () => {
    scenario.slotOffered = false;
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("slot_taken");
    expect(commits()).toHaveLength(0);
  });

  it("re-checks against the STUDIO-LOCAL date, exactly as public booking does", async () => {
    // 02:30Z is the PREVIOUS calendar day in Toronto (UTC-4 or UTC-5, and the
    // sign does not change across DST). Looking the day up in UTC would ask for
    // the wrong date and offer the wrong grid — the trap the public route
    // documents. The expectation is derived independently of the
    // implementation: it is simply "the UTC day minus one".
    scenario.timezone = "America/Toronto";
    const utcDay = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const lateEvening = `${utcDay}T02:30:00.000Z`;
    scenario.generatedSlots = [
      { start: lateEvening, end: lateEvening, startLabel: "10:30 PM" },
    ];
    await bookAnotherAppointmentAction(form({ startsAt: lateEvening }));
    expect(slotCalls).toHaveLength(1);
    expect(slotCalls[0].dateStr).toBe(addDays(utcDay, -1));
    expect(slotCalls[0].dateStr, "the UTC date is the wrong day here").not.toBe(utcDay);
  });

  it("asks the generator for the SERVICE's duration, from the shared read", async () => {
    await bookAnotherAppointmentAction(form());
    expect(slotCalls[0].durationMinutes).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// N + O. The established post-commit workflow, and its containment.
// ---------------------------------------------------------------------------

describe("N. a successful booking runs the normal booking side effects", () => {
  it("confirms to the client, notifies the practitioner, and revalidates", async () => {
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(true);
    expect(emails).toContainEqual({
      kind: "client_confirmation",
      to: "returning@example.test",
    });
    expect(emails).toContainEqual({
      kind: "practitioner_notification",
      to: "chloe@studio.test",
    });
    expect(notifications).toHaveLength(1);
    expect(revalidated).toContain("/portal");
    expect(revalidated).toContain("/calendar");
    expect(revalidated).toContain("/calendar/upcoming");
  });

  it("runs the EXISTING booking SMS path, with the stored consent state", async () => {
    scenario.smsConsentAt = "2026-01-01T00:00:00.000Z";
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(true);
    expect(smsCalls).toHaveLength(1);
    expect(smsCalls[0]).toMatchObject({
      appointmentId: APPOINTMENT_ID,
      phone: "+15550100",
      consentAt: "2026-01-01T00:00:00.000Z",
      optedOutAt: null,
    });
  });

  it("passes an OPTED-OUT client through untouched — the sender owns the gate", async () => {
    scenario.smsOptedOutAt = "2026-02-01T00:00:00.000Z";
    await bookAnotherAppointmentAction(form());
    expect(smsCalls[0].optedOutAt).toBe("2026-02-01T00:00:00.000Z");
    // Nothing on this surface may write consent state.
    const writes = reads.filter((r) => r.table === "clients");
    expect(writes.every((r) => r.filters.id === SESSION_CLIENT)).toBe(true);
  });

  it("never stamps SMS consent from this surface", async () => {
    await bookAnotherAppointmentAction(form());
    // The only RPC is the appointment command; no consent write of any kind.
    expect(rpcs.map((r) => r.fn)).toEqual(["create_public_appointment"]);
  });
});

describe("O. a post-commit failure can never falsify the booking", () => {
  const EFFECTS = [
    "intake",
    "confirmation_email",
    "email_attempt",
    "practitioner_notification",
    "practitioner_email",
    "sms",
    "revalidate",
  ];

  for (const effect of EFFECTS) {
    it(`survives a throw from ${effect}`, async () => {
      throwIn.add(effect);
      const out = await bookAnotherAppointmentAction(form());
      expect(out.ok, `${effect} must not turn a committed booking into a failure`).toBe(
        true,
      );
      if (!out.ok) throw new Error("unreachable");
      expect(out.appointmentId).toBe(APPOINTMENT_ID);
      expect(out.manageUrl).toContain("/manage/");
    });
  }

  it("survives ALL of them throwing at once", async () => {
    for (const e of EFFECTS) throwIn.add(e);
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.appointmentId).toBe(APPOINTMENT_ID);
  });

  it("a thrown confirmation sender is reported as `failed`, never as `sent`", async () => {
    throwIn.add("confirmation_email");
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.confirmationEmailStatus).toBe("failed");
  });

  it("NON-VACUITY: without the throw the same effect reports success", async () => {
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok && out.confirmationEmailStatus).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// P1-1. The service menu and the validation are ONE read.
// ---------------------------------------------------------------------------

describe("P1-1. services are read through the portal-authorized admin path", () => {
  it("reads the services list scoped by studio_id AND active", async () => {
    await bookAnotherAppointmentAction(form());
    const serviceRead = reads.find((r) => r.table === "services");
    expect(serviceRead?.filters).toMatchObject({
      studio_id: SESSION_STUDIO,
      active: true,
    });
  });

  it("never asks for a service by a browser-supplied studio", async () => {
    await bookAnotherAppointmentAction(
      form({ studio_id: OTHER_STUDIO, studioId: OTHER_STUDIO }),
    );
    for (const r of reads.filter((x) => x.table === "services")) {
      expect(r.filters.studio_id).toBe(SESSION_STUDIO);
    }
  });

  it("a services READ FAILURE is 'unavailable', never an empty menu", async () => {
    scenario.serviceReadError = { code: "57014" };
    const out = await bookAnotherAppointmentAction(form());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("unavailable");
    expect(out.error).toBe(PORTAL_REBOOK_GENERIC_REFUSAL);
    expect(commits()).toHaveLength(0);
  });
});
