import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// 0171 AMENDMENT, behavioural proof of the two invariants that protect the
// client's replacement management credential.
// ===========================================================================
//
// INVARIANT 1, HONE DOES NOT COMMIT A RESCHEDULE IT CANNOT DELIVER THE
// CREDENTIAL FOR. The successor's raw token is a one-time in-memory secret:
// only its SHA-256 is persisted, the old token is never reused, and nothing can
// regenerate it after the commit. The command re-verifies the client itself, so
// a failed application-side client lookup would NOT stop the mutation, it
// would commit, skip the email (gated on the client's address) and drop the
// token when the action returned. So the action refuses BEFORE minting the
// token or calling the command.
//
// INVARIANT 2, ONCE COMMITTED, NOTHING MAY REPORT FAILURE. Every post-commit
// read, provider call and bookkeeping write lives inside one fail-soft
// boundary. An exception escaping to the framework would surface a successful
// reschedule as a failure.
//
// These are NOT source greps. The real server action runs against an in-memory
// fake that records whether the RPC was reached and with what.

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const sentEmails: Array<Record<string, unknown>> = [];
const notifications: Array<Record<string, unknown>> = [];
const emailAttempts: Array<{ appointmentId: string; ok: boolean }> = [];
const smsCalls: Array<Record<string, unknown>> = [];

// Behaviour switches the individual tests flip.
const scenario = {
  clientLookupError: null as { code?: string; message: string } | null,
  clientRow: null as Record<string, unknown> | null,
  studioRow: null as Record<string, unknown> | null,
  rpcResult: null as Record<string, unknown> | null,
  rpcError: null as { code?: string; message: string } | null,
  practitionerThrows: false,
  serviceThrows: false,
  notificationThrows: false,
  originThrows: false,
  intakeThrows: false,
  treatmentTimeThrows: false,
  emailThrows: false,
  emailFailsNormally: false,
  emailAttemptThrows: false,
  smsThrows: false,
  sendConfirmationEmails: true,
};

const ORIGINAL = {
  id: "11111111-1111-4111-8111-111111111111",
  studio_id: "22222222-2222-4222-8222-222222222222",
  client_id: "33333333-3333-4333-8333-333333333333",
  practitioner_id: "44444444-4444-4444-8444-444444444444",
  service_id: "55555555-5555-4555-8555-555555555555",
  status: "confirmed",
  starts_at: new Date(Date.now() + 86_400_000).toISOString(),
  duration_minutes: 45,
  cancellation_token_hash: "a".repeat(64),
};

const SUCCESSOR_ID = "66666666-6666-4666-8666-666666666666";

function successRow(overrides: Record<string, unknown> = {}) {
  return {
    result: "success",
    original_appointment_id: ORIGINAL.id,
    new_appointment_id: SUCCESSOR_ID,
    studio_id: ORIGINAL.studio_id,
    client_id: ORIGINAL.client_id,
    service_id: ORIGINAL.service_id,
    practitioner_id: ORIGINAL.practitioner_id,
    original_starts_at: ORIGINAL.starts_at,
    starts_at: new Date(Date.now() + 172_800_000).toISOString(),
    ends_at: new Date(Date.now() + 172_800_000 + 45 * 60_000).toISOString(),
    duration_minutes: 45,
    created_at: new Date().toISOString(),
    policy_acknowledgement_id: null,
    ...overrides,
  };
}

// --- the in-memory admin client -------------------------------------------

function makeQuery(table: string) {
  const q: Record<string, unknown> = {};
  const chain = {
    select() {
      return chain;
    },
    eq(col: string, val: unknown) {
      q[col] = val;
      return chain;
    },
    is() {
      return chain;
    },
    async maybeSingle() {
      if (table === "appointments") {
        return { data: { ...ORIGINAL }, error: null };
      }
      if (table === "studios") {
        return { data: scenario.studioRow, error: null };
      }
      if (table === "clients") {
        if (scenario.clientLookupError) {
          return { data: null, error: scenario.clientLookupError };
        }
        return { data: scenario.clientRow, error: null };
      }
      if (table === "practitioners") {
        if (scenario.practitionerThrows) throw new Error("practitioner lookup exploded");
        return { data: { display_name: "Pract", email: "p@example.test" }, error: null };
      }
      if (table === "services") {
        if (scenario.serviceThrows) throw new Error("service lookup exploded");
        return {
          data: { name: "Svc", default_duration_minutes: 45, pre_care_instructions: null },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    async single() {
      return chain.maybeSingle();
    },
  };
  return chain;
}

const admin = {
  from(table: string) {
    return makeQuery(table);
  },
  async rpc(fn: string, args: Record<string, unknown>) {
    rpcCalls.push({ fn, args });
    if (scenario.rpcError) return { data: null, error: scenario.rpcError };
    return { data: [scenario.rpcResult ?? successRow()], error: null };
  },
};

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => admin,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitTokenRoute: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));
vi.mock("@/lib/booking/appointment-token", () => ({
  generateAppointmentToken: () => "RAW-SUCCESSOR-TOKEN",
  hashAppointmentToken: (t: string) => (t === "RAW-SUCCESSOR-TOKEN" ? "b".repeat(64) : "a".repeat(64)),
}));
vi.mock("@/lib/booking/tokens", () => ({
  verifyCancellationToken: () => ({ ok: false }),
}));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: (p: Record<string, unknown>) => {
    if (scenario.notificationThrows) throw new Error("notification exploded");
    notifications.push(p);
  },
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: () => {
    if (scenario.originThrows) throw new Error("origin exploded");
    return "https://hone.test";
  },
}));

vi.mock("@/lib/intake/queries", () => ({
  ensureIntakeForClient: async () => {
    if (scenario.intakeThrows) throw new Error("intake exploded");
    return null;
  },
}));
vi.mock("@/lib/treatment-time/queries", () => ({
  buildTreatmentTimeLine: () => null,
  getTreatmentTimeContextForEmail: async () => {
    if (scenario.treatmentTimeThrows) throw new Error("treatment time exploded");
    return null;
  },
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: async (p: Record<string, unknown>) => {
    if (scenario.emailThrows) throw new Error("email exploded");
    sentEmails.push(p);
    return scenario.emailFailsNormally
      ? { ok: false, error: "provider down", retryable: true }
      : { ok: true };
  },
  recordEmailAttempt: async (_a: unknown, id: string, _t: string, ok: boolean) => {
    if (scenario.emailAttemptThrows) throw new Error("attempt write exploded");
    emailAttempts.push({ appointmentId: id, ok });
  },
  logEmailFailure: () => {},
}));
vi.mock("@/lib/sms/send-appointment", () => ({
  sendBookingConfirmationSmsToClient: async (p: Record<string, unknown>) => {
    if (scenario.smsThrows) throw new Error("sms exploded");
    smsCalls.push(p);
  },
}));

const { rescheduleAppointmentViaTokenAction } = await import(
  "@/app/reschedule/[token]/actions"
);

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("token", "raw-url-token");
  fd.set("starts_at", new Date(Date.now() + 172_800_000).toISOString());
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  rpcCalls.length = 0;
  sentEmails.length = 0;
  notifications.length = 0;
  emailAttempts.length = 0;
  smsCalls.length = 0;
  Object.assign(scenario, {
    clientLookupError: null,
    clientRow: {
      name: "Test Client",
      email: "client@example.test",
      phone: "+15555550000",
      sms_consent_at: null,
      sms_opted_out_at: null,
    },
    studioRow: {
      id: ORIGINAL.studio_id,
      name: "Studio",
      timezone: "UTC",
      send_confirmation_emails: true,
      show_treatment_time_to_clients: false,
    },
    rpcResult: null,
    rpcError: null,
    practitionerThrows: false,
    serviceThrows: false,
    notificationThrows: false,
    originThrows: false,
    intakeThrows: false,
    treatmentTimeThrows: false,
    emailThrows: false,
    emailFailsNormally: false,
    emailAttemptThrows: false,
    smsThrows: false,
    sendConfirmationEmails: true,
  });
});

// ===========================================================================

describe("0171: the reschedule does not commit without a deliverable credential", () => {
  it("REFUSES before the command when the client lookup errors", async () => {
    scenario.clientLookupError = { code: "57014", message: "canceling statement" };
    const r = await rescheduleAppointmentViaTokenAction(form());

    expect(r.ok).toBe(false);
    // The whole point: the mutation must not have been attempted.
    expect(rpcCalls).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(smsCalls).toHaveLength(0);
    if (!r.ok) expect(r.error).toBe("This reschedule link can't be used right now.");
  });

  it("REFUSES before the command when the client row is missing", async () => {
    scenario.clientRow = null;
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });

  it.each([
    ["null email", null],
    ["empty email", ""],
    ["whitespace-only email", "   "],
  ])("REFUSES before the command on %s", async (_label, email) => {
    scenario.clientRow = { ...scenario.clientRow, email };
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(false);
    expect(rpcCalls).toHaveLength(0);
    // No false claim that the client can manage a successor.
    expect(sentEmails).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it("no successor token hash crosses the database boundary on refusal", async () => {
    scenario.clientRow = null;
    await rescheduleAppointmentViaTokenAction(form());
    expect(
      rpcCalls.some((c) => "p_new_cancellation_token_hash" in c.args),
    ).toBe(false);
  });

  it("proceeds normally when the client metadata IS available", async () => {
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("reschedule_appointment_v2");
    // The hash of the freshly-minted raw token, never the raw token itself.
    expect(rpcCalls[0].args.p_new_cancellation_token_hash).toBe("b".repeat(64));
    expect(JSON.stringify(rpcCalls[0].args)).not.toContain("RAW-SUCCESSOR-TOKEN");
  });

  it("builds the management links from the NEW raw token", async () => {
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].cancellationUrl).toBe(
      "https://hone.test/cancel/RAW-SUCCESSOR-TOKEN",
    );
    expect(sentEmails[0].rescheduleUrl).toBe(
      "https://hone.test/reschedule/RAW-SUCCESSOR-TOKEN",
    );
  });
});

// ===========================================================================

describe("0171: once committed, no post-commit failure may report failure", () => {
  it.each([
    ["practitioner metadata lookup throws", "practitionerThrows"],
    ["service metadata lookup throws", "serviceThrows"],
    ["practitioner notification throws synchronously", "notificationThrows"],
    ["intake helper throws", "intakeThrows"],
    ["treatment-time helper throws", "treatmentTimeThrows"],
    ["confirmation email helper throws", "emailThrows"],
    ["email-attempt recording throws", "emailAttemptThrows"],
    ["SMS helper throws despite its never-throw contract", "smsThrows"],
  ])("still returns success when the %s", async (_label, flag) => {
    (scenario as Record<string, unknown>)[flag] = true;
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newAppointmentId).toBe(SUCCESSOR_ID);
    // The mutation happened exactly once regardless.
    expect(rpcCalls).toHaveLength(1);
  });

  // AMENDED: a practitioner-lookup throw used to abort the shared try, so the
  // email never went out at all. It is now an ISOLATED optional enrichment: the
  // display name degrades to the studio name and the confirmation still sends.
  it("uses the studio-name fallback when the practitioner lookup throws, and STILL emails", async () => {
    scenario.practitionerThrows = true;
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].practitionerDisplayName).toBe("Studio");
    if (r.ok) expect(r.confirmationEmailStatus).toBe("sent");
  });

  it("records the failed attempt and still returns success when the provider fails normally", async () => {
    scenario.emailFailsNormally = true;
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    expect(emailAttempts).toEqual([{ appointmentId: SUCCESSOR_ID, ok: false }]);
  });

  it("does not reschedule twice when a post-commit step fails", async () => {
    scenario.emailThrows = true;
    await rescheduleAppointmentViaTokenAction(form());
    expect(rpcCalls).toHaveLength(1);
  });
});

// ===========================================================================

describe("0171: malformed command success rows", () => {
  it.each([
    "new_appointment_id",
    "studio_id",
    "client_id",
    "starts_at",
    "ends_at",
    "created_at",
    "original_starts_at",
  ])("does not build downstream state from a success row missing %s", async (field) => {
    scenario.rpcResult = successRow({ [field]: null });
    const r = await rescheduleAppointmentViaTokenAction(form());
    // The mutation IS committed, so a missing id is the only case that can
    // honestly refuse; everything else still reports the committed success.
    if (field === "new_appointment_id") {
      expect(r.ok).toBe(false);
    } else {
      expect(r.ok).toBe(true);
    }
    // Under NO circumstance may a malformed row produce an email built from
    // undefined values.
    expect(sentEmails).toHaveLength(0);
  });

  it("rejects a non-positive duration as malformed", async () => {
    scenario.rpcResult = successRow({ duration_minutes: 0 });
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    expect(sentEmails).toHaveLength(0);
  });

  it("accepts null service_id and null practitioner_id as legitimate", async () => {
    scenario.rpcResult = successRow({ service_id: null, practitioner_id: null });
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    expect(sentEmails).toHaveLength(1);
    expect(notifications[0].practitionerId).toBeNull();
  });
});

// ===========================================================================

describe("0171: refusal codes still map before any side effect", () => {
  it.each([
    ["appointment_not_found", "This reschedule link can't be used right now."],
    ["appointment_not_reschedulable", "This reschedule link can't be used right now."],
    ["same_time", null],
    ["policy_changed", null],
    ["policy_ack_required", null],
    ["payment_state_requires_studio", null],
    ["practitioner_unavailable", null],
    ["not_a_public_slot", null],
    ["time_unavailable", null],
  ])("%s produces no side effects", async (code, exactCopy) => {
    scenario.rpcResult = { result: code };
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(false);
    if (!r.ok && exactCopy) expect(r.error).toBe(exactCopy);
    if (!r.ok) expect(r.error).not.toMatch(/postgres|sqlstate|constraint|relation/i);
    expect(sentEmails).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(smsCalls).toHaveLength(0);
  });
});

// ===========================================================================
// 0171 AMENDMENT, the successful result must carry a usable management path.
// ===========================================================================
//
// The email is not a reliable carrier: it can be switched off, it can be
// skipped by an unrelated optional failure, or the provider can simply refuse.
// The action holds the raw successor token and the browser is already
// authorised by the ORIGINAL token, so the success response itself carries the
// URL.

describe("0171: the success result always carries a management path", () => {
  it("provider succeeds: status 'sent', manage URL returned, email uses the same token", async () => {
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.confirmationEmailStatus).toBe("sent");
    expect(r.manageUrl).toBe("https://hone.test/manage/RAW-SUCCESSOR-TOKEN");
    expect(sentEmails).toHaveLength(1);
    // The email's links and the returned URL are the SAME successor token.
    expect(sentEmails[0].cancellationUrl).toContain("RAW-SUCCESSOR-TOKEN");
    expect(sentEmails[0].rescheduleUrl).toContain("RAW-SUCCESSOR-TOKEN");
  });

  it("confirmation emails DISABLED: no email call, status 'disabled', URL still returned", async () => {
    scenario.studioRow = { ...scenario.studioRow, send_confirmation_emails: false };
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sentEmails).toHaveLength(0);
    expect(emailAttempts).toHaveLength(0);
    expect(r.confirmationEmailStatus).toBe("disabled");
    expect(r.manageUrl).toBe("https://hone.test/manage/RAW-SUCCESSOR-TOKEN");
    // The reschedule itself still happened exactly once.
    expect(rpcCalls).toHaveLength(1);
  });

  it("provider returns a normal failure: status 'failed', URL returned, action succeeds", async () => {
    scenario.emailFailsNormally = true;
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.confirmationEmailStatus).toBe("failed");
    expect(r.manageUrl).toContain("/manage/RAW-SUCCESSOR-TOKEN");
    expect(emailAttempts).toEqual([{ appointmentId: SUCCESSOR_ID, ok: false }]);
  });

  it("provider THROWS: status 'failed', URL returned, action succeeds", async () => {
    scenario.emailThrows = true;
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.confirmationEmailStatus).toBe("failed");
    expect(r.manageUrl).toContain("/manage/RAW-SUCCESSOR-TOKEN");
  });

  it("email-attempt bookkeeping failure does not corrupt the reported delivery status", async () => {
    scenario.emailAttemptThrows = true;
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The PROVIDER succeeded, so the truthful status is 'sent' even though the
    // bookkeeping write blew up.
    expect(r.confirmationEmailStatus).toBe("sent");
    expect(r.manageUrl).toContain("/manage/");
  });
});

describe("0171: optional failures cannot suppress the confirmation", () => {
  // The regression these close: ONE shared try meant an optional practitioner
  // lookup jumped straight to the catch and the client's email, the carrier of
  // their management credential, was never attempted at all.
  it.each([
    ["practitioner lookup", "practitionerThrows"],
    ["service lookup", "serviceThrows"],
    ["intake helper", "intakeThrows"],
    ["treatment-time helper", "treatmentTimeThrows"],
    ["practitioner notification", "notificationThrows"],
  ])("the %s throwing STILL attempts the client email", async (_label, flag) => {
    (scenario as Record<string, unknown>)[flag] = true;
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    // Not merely ok:true with zero email attempts, the email really ran.
    expect(sentEmails).toHaveLength(1);
    if (!r.ok) return;
    expect(r.confirmationEmailStatus).toBe("sent");
    expect(r.manageUrl).toContain("/manage/RAW-SUCCESSOR-TOKEN");
  });

  it("a failed practitioner lookup falls back to the STUDIO NAME and still emails", async () => {
    scenario.practitionerThrows = true;
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].practitionerDisplayName).toBe("Studio");
  });

  it("a failed service lookup passes a null service and still emails", async () => {
    scenario.serviceThrows = true;
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(true);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].service).toBeNull();
  });

  it("a failed intake omits the intake link and still emails", async () => {
    scenario.intakeThrows = true;
    await rescheduleAppointmentViaTokenAction(form());
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].intakeUrl).toBeNull();
  });
});

describe("0171: SMS is independent of the email toggle", () => {
  it("SMS is still attempted when confirmation emails are DISABLED", async () => {
    scenario.studioRow = { ...scenario.studioRow, send_confirmation_emails: false };
    await rescheduleAppointmentViaTokenAction(form());
    expect(sentEmails).toHaveLength(0);
    // The SMS helper owns its own toggle/consent/opt-out gates, so it must be
    // CALLED and allowed to decide, it used to be nested under the email
    // block and skipped entirely.
    expect(smsCalls).toHaveLength(1);
    expect(smsCalls[0].manageUrl).toBe("https://hone.test/manage/RAW-SUCCESSOR-TOKEN");
  });

  it("SMS is still attempted when the email provider fails", async () => {
    scenario.emailThrows = true;
    await rescheduleAppointmentViaTokenAction(form());
    expect(smsCalls).toHaveLength(1);
  });
});

describe("0171: origin resolution is a PRE-command gate", () => {
  it("refuses before the RPC when the app origin cannot be resolved", async () => {
    scenario.originThrows = true;
    const r = await rescheduleAppointmentViaTokenAction(form());
    expect(r.ok).toBe(false);
    // No mutation: a reschedule that commits without an origin leaves the
    // client with no link at all.
    expect(rpcCalls).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
    expect(smsCalls).toHaveLength(0);
  });
});

describe("0171: the raw token never reaches a log", () => {
  it("no logged line contains the raw successor token, in any failure mode", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      for (const flag of [
        "practitionerThrows",
        "serviceThrows",
        "intakeThrows",
        "treatmentTimeThrows",
        "notificationThrows",
        "emailThrows",
        "emailAttemptThrows",
        "smsThrows",
      ]) {
        (scenario as Record<string, unknown>)[flag] = true;
        await rescheduleAppointmentViaTokenAction(form());
        (scenario as Record<string, unknown>)[flag] = false;
      }
    } finally {
      spy.mockRestore();
    }
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain("RAW-SUCCESSOR-TOKEN");
      expect(line).not.toContain("/manage/");
      // And no arbitrary thrown message, which could carry a URL or address.
      expect(line).not.toContain("exploded");
    }
  });
});
