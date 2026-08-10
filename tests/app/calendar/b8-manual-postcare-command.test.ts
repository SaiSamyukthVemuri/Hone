import { describe, expect, it, vi, beforeEach } from "vitest";

// B8 / 0177 — sendPostcareEmailAction, BEHAVIOURALLY.
//
// tests/app/calendar/postcare-send-state.test.ts is a SOURCE-CONTRACT suite: it
// reads the action's text. This one runs the real exported action against a
// fake whose only mutation surface is `rpc`, and asserts what actually happens.
//
// TWO FAKES, DELIBERATELY. The default admin THROWS on any direct
// `.update()/.insert()/.delete()` of appointments, so a reintroduced writer
// fails loudly. The deployment-skew fake instead lets a direct UPDATE SUCCEED
// and counts it — because a fake that always throws cannot distinguish "the
// application never attempted a fallback" from "it attempted one and the fake
// killed it", and that distinction is the entire point of the skew proof.

const CLAIM_TOKEN = "2026-08-10T15:04:05.123+00:00";
const APPT = "aaaaaaaa-1111-2222-3333-444444444444";
const STUDIO = "bbbbbbbb-1111-2222-3333-444444444444";
const PRACTITIONER = "cccccccc-1111-2222-3333-444444444444";

type RpcCall = { fn: string; args: Record<string, unknown> };

const state: {
  // ONE ORDERED TRANSCRIPT. The per-kind arrays below prove WHAT was called and
  // with which arguments; they cannot prove the provider ran BETWEEN the claim
  // and the settlement — two separate arrays each in order are consistent with
  // provider-then-claim-then-settle. This records every orchestration step in a
  // single sequence so the ordering itself is assertable.
  events: string[];
  rpc: RpcCall[];
  directDml: string[];
  provider: Array<Record<string, unknown>>;
  claim: { data?: unknown; error?: unknown };
  settle: { data?: unknown; error?: unknown };
  providerResult: { ok: boolean; retryable?: boolean; error?: string };
  row: Record<string, unknown> | null;
  allowDirectDml: boolean;
} = {
  events: [],
  rpc: [],
  directDml: [],
  provider: [],
  claim: {},
  settle: {},
  providerResult: { ok: true },
  row: null,
  allowDirectDml: false,
};

function appointmentRow(over: Record<string, unknown> = {}) {
  return {
    id: APPT,
    studio_id: STUDIO,
    status: "completed",
    starts_at: "2026-08-10T12:00:00.000Z",
    postcare_email_sent_at: null,
    postcare_email_send_attempts: 0,
    postcare_email_claimed_at: null,
    postcare_email_failed_at: null,
    client: { id: "client-1", name: "Client", email: "c@example.com" },
    service: { id: "svc-1", name: "Electrolysis", modality: "electrolysis" },
    studio: {
      id: STUDIO,
      name: "Studio",
      owner_email: "o@example.com",
      timezone: "America/Toronto",
      postcare_aftercare_text: "Ice the area.",
      postcare_warning_signs_text: null,
      postcare_product_recommendations_text: null,
      postcare_review_url: null,
      postcare_review_prompt_text: null,
      postcare_contact_email: null,
    },
    practitioner: { id: PRACTITIONER, display_name: "Prac" },
    ...over,
  };
}

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: PRACTITIONER, role: "owner", active: true },
    studio: { id: STUDIO, name: "Studio", timezone: "America/Toronto" },
  }),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitTokenRoute: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));

vi.mock("@/lib/email/send-appointment", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    sendPostcareToClient: async (args: Record<string, unknown>) => {
      state.events.push("provider");
      state.provider.push(args);
      return state.providerResult;
    },
  };
});

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.is = () => q;
      q.or = () => q;
      q.maybeSingle = async () => ({ data: state.row, error: null });
      const forbid = (op: string) => {
        state.events.push(`direct:${op}`);
        state.directDml.push(`${table}.${op}`);
        if (!state.allowDirectDml) {
          throw new Error(`B8: direct ${op} on ${table} is forbidden after 0177`);
        }
        // SKEW MODE: succeed, so "never attempted" and "attempted and died"
        // are distinguishable.
        const ok: Record<string, unknown> = {};
        ok.eq = () => ok;
        ok.is = () => ok;
        ok.or = () => ok;
        ok.select = async () => ({ data: [{ id: APPT }], error: null });
        ok.then = (r: (v: unknown) => unknown) => r({ data: [{ id: APPT }], error: null });
        return ok;
      };
      q.update = () => forbid("update");
      q.insert = () => forbid("insert");
      q.delete = () => forbid("delete");
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.events.push(fn === "claim_postcare_send" ? "claim" : "settle");
      state.rpc.push({ fn, args });
      if (fn === "claim_postcare_send") {
        return state.claim.data !== undefined || state.claim.error !== undefined
          ? state.claim
          : { data: [{ result: "claimed", claimed_at: CLAIM_TOKEN, send_attempts: 1 }], error: null };
      }
      return state.settle.data !== undefined || state.settle.error !== undefined
        ? state.settle
        : { data: [{ result: "settled" }], error: null };
    },
  }),
}));

import { sendPostcareEmailAction } from "@/app/(app)/calendar/actions";

function fd(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("appointment_id", APPT);
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

const claims = () => state.rpc.filter((c) => c.fn === "claim_postcare_send");
const settles = () => state.rpc.filter((c) => c.fn === "settle_postcare_send");

beforeEach(() => {
  state.events = [];
  state.rpc = [];
  state.directDml = [];
  state.provider = [];
  state.claim = {};
  state.settle = {};
  state.providerResult = { ok: true };
  state.row = appointmentRow();
  state.allowDirectDml = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
describe("B8 manual — the governed happy path", () => {
  it("B — claim, provider, settle, in that order, exactly once each", async () => {
    const res = await sendPostcareEmailAction(fd());

    expect(res.ok, JSON.stringify(res)).toBe(true);
    // THE ORDERING ASSERTION. Exactly these three steps, in exactly this order,
    // with nothing else interleaved.
    expect(state.events).toEqual(["claim", "provider", "settle"]);
    expect(state.rpc.map((c) => c.fn)).toEqual([
      "claim_postcare_send",
      "settle_postcare_send",
    ]);
    expect(state.provider).toHaveLength(1);
    expect(state.directDml, "no direct appointment mutation").toEqual([]);
    expect(claims()[0].args).toMatchObject({
      p_appointment_id: APPT,
      p_studio_id: STUDIO,
      p_actor_practitioner_id: PRACTITIONER,
      p_is_resend: false,
    });
  });

  it("TOKEN IDENTITY — settle receives the claim's value with strict equality", async () => {
    await sendPostcareEmailAction(fd());
    // Not "a date equal to it" — the SAME string. A Date round trip here would
    // round microseconds away and settlement would miss its own claim.
    expect(settles()[0].args.p_claimed_at).toBe(CLAIM_TOKEN);
    expect(typeof settles()[0].args.p_claimed_at).toBe("string");
    expect(settles()[0].args.p_success).toBe(true);
  });

  it("G — a resend claims with p_is_resend true", async () => {
    state.row = appointmentRow({ postcare_email_sent_at: "2026-08-01T10:00:00.000Z" });
    await sendPostcareEmailAction(fd({ is_resend: "true" }));
    expect(claims()[0].args.p_is_resend).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("B8 manual — refusals never reach the provider", () => {
  it.each([
    ["A already_claimed", "already_claimed"],
    ["J2 not_completed", "not_completed"],
    ["not_authorized", "not_authorized"],
    ["already_sent", "already_sent"],
  ])("%s — provider and settle are never called", async (_label, result) => {
    state.claim = { data: [{ result, claimed_at: null }], error: null };

    const res = await sendPostcareEmailAction(fd());

    expect(res.ok).toBe(false);
    expect(state.events, "a refusal ends after the claim").toEqual(["claim"]);
    expect(state.provider, "provider must not run on a refusal").toHaveLength(0);
    expect(settles(), "nothing to settle").toHaveLength(0);
    expect(state.directDml).toEqual([]);
  });

  it("J2 — the not-completed copy tells the practitioner what to do", async () => {
    state.claim = { data: [{ result: "not_completed", claimed_at: null }], error: null };
    const res = await sendPostcareEmailAction(fd());
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.error).toMatch(/once the appointment is completed/i);
  });
});

// ---------------------------------------------------------------------------
describe("B8 manual — provider failure settles honestly", () => {
  it.each([true, false])("C — retryable=%s is forwarded exactly", async (retryable) => {
    state.providerResult = { ok: false, retryable, error: "smtp said no: user@host" };

    const res = await sendPostcareEmailAction(fd());

    expect(res.ok).toBe(false);
    expect(settles()).toHaveLength(1);
    expect(settles()[0].args).toMatchObject({
      p_appointment_id: APPT,
      p_studio_id: STUDIO,
      p_claimed_at: CLAIM_TOKEN,
      p_success: false,
      p_retryable: retryable,
    });
    // No provider payload crosses the boundary — the safe copy is derived in
    // SQL from the boolean alone.
    const serialized = JSON.stringify(settles()[0].args);
    expect(serialized).not.toMatch(/smtp said no|user@host/);
  });
});

// ---------------------------------------------------------------------------
describe("B8 manual — provider truth is not persisted truth", () => {
  it.each([
    ["D settle RPC error", { data: null, error: { code: "57014", message: "canceled" } }],
    ["E stale_claim", { data: [{ result: "stale_claim" }], error: null }],
  ])("%s — never ordinary success", async (_label, settle) => {
    state.settle = settle as never;

    const res = await sendPostcareEmailAction(fd());

    // The email IS out. Reporting ok:true would assert a durable sent_at that
    // does not exist; reporting a plain failure would deny a real send.
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.code).toBe("provider_sent_status_unrecorded");
      expect(res.error).toMatch(/accepted the message/i);
      // Must not invite an immediate retry — that would duplicate a real email.
      expect(res.error).not.toMatch(/try again now|resend now/i);
    }
    // Exactly one send, one settlement attempt, and NOTHING after it — no
    // retry, no second settlement under a new token, no direct repair.
    expect(state.events).toEqual(["claim", "provider", "settle"]);
    expect(state.provider).toHaveLength(1);
    expect(settles()).toHaveLength(1);
    expect(state.directDml).toEqual([]);
  });

  it("F — provider failure whose settlement also fails fabricates nothing", async () => {
    state.providerResult = { ok: false, retryable: true, error: "boom" };
    state.settle = { data: null, error: { code: "57014" } };

    const res = await sendPostcareEmailAction(fd());

    expect(res.ok).toBe(false);
    // One settlement attempt, no second under a different token, no repair.
    expect(settles()).toHaveLength(1);
    expect(state.directDml).toEqual([]);
    expect(state.provider).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("B8 manual — eligibility gates run BEFORE any claim", () => {
  it("H — a consultation without treatment attestation never claims", async () => {
    state.row = appointmentRow({
      service: { id: "svc-1", name: "Consultation", modality: "consultation" },
    });
    const res = await sendPostcareEmailAction(fd());
    expect(res.ok).toBe(false);
    expect(state.events, "no orchestration step may run").toEqual([]);
    expect(claims()).toHaveLength(0);
    expect(state.provider).toHaveLength(0);
  });

  it("H — the same consultation WITH attestation proceeds", async () => {
    // Non-vacuity: proves the previous case failed for the attestation and not
    // for some unrelated reason in the fixture.
    state.row = appointmentRow({
      service: { id: "svc-1", name: "Consultation", modality: "consultation" },
    });
    const res = await sendPostcareEmailAction(
      fd({ treatment_performed_during_consultation: "true" }),
    );
    expect(res.ok).toBe(true);
    expect(claims()).toHaveLength(1);
  });

  it("I — a client with no email never claims", async () => {
    state.row = appointmentRow({
      client: { id: "client-1", name: "Client", email: null },
    });
    const res = await sendPostcareEmailAction(fd());
    expect(res.ok).toBe(false);
    expect(state.events).toEqual([]);
    expect(claims()).toHaveLength(0);
    expect(state.provider).toHaveLength(0);
  });

  it("J — unconfigured postcare never claims", async () => {
    const row = appointmentRow();
    (row.studio as Record<string, unknown>).postcare_aftercare_text = "   ";
    state.row = row;
    const res = await sendPostcareEmailAction(fd());
    expect(res.ok).toBe(false);
    expect(state.events).toEqual([]);
    expect(claims()).toHaveLength(0);
    expect(state.provider).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("B8 deployment skew — STATE A: new app, old (0176) database", () => {
  it("a missing command fails closed and attempts NO direct-DML fallback", async () => {
    // THE LOAD-BEARING SETUP: direct DML is allowed to SUCCEED here. If the
    // fake threw instead, "never attempted a fallback" and "attempted one that
    // died in the fake" would be indistinguishable.
    state.allowDirectDml = true;
    state.claim = {
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.claim_postcare_send in the schema cache",
      },
    };

    const res = await sendPostcareEmailAction(fd());

    expect(res.ok).toBe(false);
    expect(state.provider, "no email during the skew window").toHaveLength(0);
    expect(settles()).toHaveLength(0);
    expect(
      state.directDml,
      "the action must not fall back to a direct appointment write",
    ).toEqual([]);
    // The transcript shows the whole orchestration: a fallback would appear as
    // `direct:update` here even though the fake would have let it succeed.
    expect(state.events).toEqual(["claim"]);
    // And it leaks nothing about the deployment state.
    if (res.ok === false) {
      expect(res.error).not.toMatch(/PGRST|schema cache|migration|deploy/i);
    }
  });
});
