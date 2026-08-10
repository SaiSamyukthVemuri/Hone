import { describe, expect, it, vi } from "vitest";
import {
  shouldAutoSendPostcare,
  autoSendPostcareOnComplete,
} from "@/app/(app)/calendar/postcare-auto-send";

// B8 / 0177: the server-resolved practitioner the database authenticates.
const ACTOR = "11111111-2222-3333-4444-555555555555";

// No real email is ever sent: the pure gate is data-only, and the orchestration
// tests inject a fake admin client + a fake sender.

describe("shouldAutoSendPostcare — eligibility gate", () => {
  const base = {
    deliveryMode: "auto_on_complete",
    status: "completed",
    serviceModality: "electrolysis",
    clientEmail: "c@example.com",
    aftercareText: "Ice the area.",
  };
  it("eligible: auto + completed + non-consultation + email + aftercare", () => {
    expect(shouldAutoSendPostcare(base)).toEqual({ ok: true });
  });
  it("manual (or unset, pre-migration) mode → skipped_mode", () => {
    expect(shouldAutoSendPostcare({ ...base, deliveryMode: "manual" })).toEqual({ ok: false, reason: "skipped_mode" });
    expect(shouldAutoSendPostcare({ ...base, deliveryMode: undefined })).toEqual({ ok: false, reason: "skipped_mode" });
    expect(shouldAutoSendPostcare({ ...base, deliveryMode: null })).toEqual({ ok: false, reason: "skipped_mode" });
  });
  it("cancelled / no_show / not-completed → skipped_not_completed (never auto-sends)", () => {
    for (const status of ["cancelled", "no_show", "confirmed", null, undefined]) {
      expect(shouldAutoSendPostcare({ ...base, status })).toEqual({ ok: false, reason: "skipped_not_completed" });
    }
  });
  it("consultation modality → skipped_consultation (no treatment attestation in auto path)", () => {
    expect(shouldAutoSendPostcare({ ...base, serviceModality: "consultation" })).toEqual({ ok: false, reason: "skipped_consultation" });
  });
  it("no client email → skipped_no_email", () => {
    expect(shouldAutoSendPostcare({ ...base, clientEmail: null })).toEqual({ ok: false, reason: "skipped_no_email" });
    expect(shouldAutoSendPostcare({ ...base, clientEmail: "   " })).toEqual({ ok: false, reason: "skipped_no_email" });
  });
  it("no studio aftercare text → skipped_no_aftercare", () => {
    expect(shouldAutoSendPostcare({ ...base, aftercareText: "" })).toEqual({ ok: false, reason: "skipped_no_aftercare" });
  });
});

// Minimal chainable + thenable fake Supabase admin client. Load chain ends at
// maybeSingle(); the claim update chain ends at select("id"); record-write
// chains end at eq() and are awaited directly.
//
// PR B1 REPAIR. The previous fake was vacuous in two ways that mattered:
//
//   b.from = () => b;   // discarded the TABLE NAME
//   b.eq   = () => b;   // discarded every FILTER, including the tenant scope
//
// so it could not distinguish a write to `appointments` from a write to any
// other table, and could not notice `.eq("studio_id", studioId)` disappearing.
// Those are the two properties that make these three service-role writes safe:
// they are the only direct `appointments` DML left in the application (frozen
// by tests/security/appointment-direct-dml-guard.test.ts), and the tenant
// predicate is the sole thing keeping a service-role client — which bypasses
// RLS entirely — inside one studio.
//
// The fake now records one Chain per `.from(...)` call, with its table, its
// operation, its payload and every predicate in order.

type Chain = {
  table: string;
  op: "select" | "update" | null;
  payload: Record<string, unknown> | null;
  /** `.eq(column, value)` in call order. */
  eq: Array<[string, unknown]>;
  /** `.is(column, value)` in call order. */
  is: Array<[string, unknown]>;
  /** `.or(filterString)` in call order. */
  or: string[];
};

function fakeAdmin(cfg: {
  appt: unknown;
  claimRows: unknown[];
  updates: Record<string, unknown>[];
  chains?: Chain[];
}) {
  let pendingClaim = false;
  const chains = cfg.chains ?? [];
  let cur: Chain | null = null;
  const b: Record<string, unknown> = {};

  b.from = (table: string) => {
    cur = { table, op: null, payload: null, eq: [], is: [], or: [] };
    chains.push(cur);
    return b;
  };
  b.select = () => {
    // `.select("id")` after `.update(...)` is the claim proof, not a read — do
    // not let it relabel the chain's operation.
    if (cur && cur.op === null) cur.op = "select";
    if (pendingClaim) {
      pendingClaim = false;
      return Promise.resolve({ data: cfg.claimRows, error: null });
    }
    return b;
  };
  b.update = (payload: Record<string, unknown>) => {
    cfg.updates.push(payload);
    if (cur) {
      cur.op = "update";
      cur.payload = payload;
    }
    // The claim update is the only one that sets send_attempts.
    pendingClaim = payload.postcare_email_send_attempts !== undefined;
    return b;
  };
  b.eq = (column: string, value: unknown) => {
    cur?.eq.push([column, value]);
    return b;
  };
  b.is = (column: string, value: unknown) => {
    cur?.is.push([column, value]);
    return b;
  };
  b.or = (filter: string) => {
    cur?.or.push(filter);
    return b;
  };
  b.maybeSingle = () => Promise.resolve({ data: cfg.appt, error: null });
  b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
  return b as unknown as { from: (t: string) => unknown };
}

/** The only columns these writers may touch. Mirrors the static guard. */
const POSTCARE_COLUMNS = new Set([
  "postcare_email_claimed_at",
  "postcare_email_failed_at",
  "postcare_email_last_attempt_at",
  "postcare_email_last_error",
  "postcare_email_send_attempts",
  "postcare_email_sent_at",
]);

const APPOINTMENT_ID = "a1";
const STUDIO_ID = "s1";

/** Every predicate assertion these three writers must satisfy, in one place. */
function expectScopedToAppointment(chain: Chain) {
  expect(chain.table, "every postcare chain must target `appointments`").toBe(
    "appointments",
  );
  expect(
    chain.eq,
    `chain (${chain.op}) lost its appointment-id predicate`,
  ).toContainEqual(["id", APPOINTMENT_ID]);
  expect(
    chain.eq,
    `chain (${chain.op}) lost its .eq("studio_id", …) tenant predicate. This client ` +
      "bypasses RLS; the predicate IS the tenant boundary.",
  ).toContainEqual(["studio_id", STUDIO_ID]);
}

const ELIGIBLE_APPT = {
  status: "completed",
  starts_at: "2026-06-03T18:30:00Z",
  postcare_email_sent_at: null,
  postcare_email_send_attempts: 0,
  client: { name: "Client", email: "c@example.com" },
  service: { name: "Electrolysis", modality: "electrolysis" },
  studio: {
    id: "s1",
    name: "Studio",
    owner_email: "o@example.com",
    timezone: "America/Toronto",
    postcare_delivery_mode: "auto_on_complete",
    postcare_aftercare_text: "Ice the area.",
    postcare_warning_signs_text: null,
    postcare_product_recommendations_text: null,
    postcare_review_url: null,
    postcare_review_prompt_text: null,
    postcare_contact_email: null,
  },
  practitioner: { display_name: "Practitioner" },
};

describe("autoSendPostcareOnComplete — orchestration (fail-soft, idempotent)", () => {
  it("NEVER throws (fail-soft) — a db failure returns 'threw', not an exception", async () => {
    const admin = { from: () => { throw new Error("db down"); } };
    await expect(autoSendPostcareOnComplete("a1", "s1", ACTOR, { admin })).resolves.toBe("threw");
  });

  it("manual mode → skipped_mode, no send, no claim update", async () => {
    const send = vi.fn();
    const updates: Record<string, unknown>[] = [];
    const admin = fakeAdmin({
      appt: { ...ELIGIBLE_APPT, studio: { ...ELIGIBLE_APPT.studio, postcare_delivery_mode: "manual" } },
      claimRows: [],
      updates,
    });
    expect(await autoSendPostcareOnComplete("a1", "s1", ACTOR, { admin, sendPostcare: send })).toBe("skipped_mode");
    expect(send).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("eligible + claim won + provider ok → sent; stamps sent_at", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const updates: Record<string, unknown>[] = [];
    const admin = fakeAdmin({ appt: ELIGIBLE_APPT, claimRows: [{ id: "a1" }], updates });
    expect(await autoSendPostcareOnComplete("a1", "s1", ACTOR, { admin, sendPostcare: send })).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
    expect(updates.some((u) => u.postcare_email_sent_at)).toBe(true);
  });

  it("eligible + claim won + provider fails → failed; records failed_at, NOT sent_at", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, retryable: true, error: "boom" });
    const updates: Record<string, unknown>[] = [];
    const admin = fakeAdmin({ appt: ELIGIBLE_APPT, claimRows: [{ id: "a1" }], updates });
    expect(await autoSendPostcareOnComplete("a1", "s1", ACTOR, { admin, sendPostcare: send })).toBe("failed");
    expect(updates.some((u) => u.postcare_email_failed_at)).toBe(true);
    expect(updates.some((u) => u.postcare_email_sent_at)).toBe(false);
  });

  it("claim returns no row (already sent / duplicate completion) → not_claimed, no send", async () => {
    const send = vi.fn();
    const updates: Record<string, unknown>[] = [];
    const admin = fakeAdmin({ appt: ELIGIBLE_APPT, claimRows: [], updates });
    expect(await autoSendPostcareOnComplete("a1", "s1", ACTOR, { admin, sendPostcare: send })).toBe("not_claimed");
    expect(send).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PR B1 — the two properties the old fake could not see.
// ===========================================================================
//
// These writes run as `service_role`, which bypasses RLS completely. Nothing in
// the database confines them to one studio or one appointment; the `.eq()`
// predicates are the entire boundary. Migration 0172 revokes `authenticated`
// DML on `appointments` precisely BECAUSE these seven writers are service-role
// and correctly scoped — so a silent loss of scope here would undermine the
// premise the revoke rests on.

describe("autoSendPostcareOnComplete — table and tenant scope (PR B1)", () => {
  async function runSuccessPath() {
    const chains: Chain[] = [];
    const updates: Record<string, unknown>[] = [];
    const admin = fakeAdmin({
      appt: ELIGIBLE_APPT,
      claimRows: [{ id: APPOINTMENT_ID }],
      updates,
      chains,
    });
    const outcome = await autoSendPostcareOnComplete(APPOINTMENT_ID, STUDIO_ID, ACTOR, {
      admin,
      sendPostcare: vi.fn().mockResolvedValue({ ok: true }),
    });
    return { chains, updates, outcome };
  }

  it("every chain — load, claim and success stamp — targets `appointments`", async () => {
    const { chains, outcome } = await runSuccessPath();
    expect(outcome).toBe("sent");
    expect(chains).toHaveLength(3);
    expect(chains.map((c) => c.table)).toEqual([
      "appointments",
      "appointments",
      "appointments",
    ]);
    expect(chains.map((c) => c.op)).toEqual(["select", "update", "update"]);
  });

  it("every chain is scoped to BOTH the appointment id and the studio id", async () => {
    const { chains } = await runSuccessPath();
    for (const c of chains) expectScopedToAppointment(c);
  });

  it("the claim additionally requires status='completed' and an unsent, unclaimed row", async () => {
    const { chains } = await runSuccessPath();
    const claim = chains[1];
    // The belt-and-suspenders guard the MANUAL path does not have (audit P3-14).
    expect(claim.eq).toContainEqual(["status", "completed"]);
    expect(claim.is).toContainEqual(["postcare_email_sent_at", null]);
    expect(claim.or.join(" ")).toContain("postcare_email_claimed_at");
  });

  it("both writes touch only postcare bookkeeping columns", async () => {
    const { chains } = await runSuccessPath();
    for (const c of chains.filter((x) => x.op === "update")) {
      const cols = Object.keys(c.payload ?? {});
      expect(cols.length).toBeGreaterThan(0);
      for (const col of cols) {
        expect(
          POSTCARE_COLUMNS.has(col),
          `postcare writer must not write \`${col}\` — scheduling, lifecycle and ` +
            "tenancy columns belong to the reviewed SQL commands",
        ).toBe(true);
      }
    }
    // The success stamp is the one that may set sent_at.
    expect(Object.keys(chains[2].payload ?? {})).toContain("postcare_email_sent_at");
  });

  it("the failure path is scoped identically and never stamps sent_at", async () => {
    const chains: Chain[] = [];
    const updates: Record<string, unknown>[] = [];
    const admin = fakeAdmin({
      appt: ELIGIBLE_APPT,
      claimRows: [{ id: APPOINTMENT_ID }],
      updates,
      chains,
    });
    const outcome = await autoSendPostcareOnComplete(APPOINTMENT_ID, STUDIO_ID, ACTOR, {
      admin,
      sendPostcare: vi.fn().mockResolvedValue({ ok: false, retryable: true, error: "boom" }),
    });
    expect(outcome).toBe("failed");
    expect(chains).toHaveLength(3);
    for (const c of chains) expectScopedToAppointment(c);
    expect(Object.keys(chains[2].payload ?? {})).not.toContain("postcare_email_sent_at");
    expect(chains[2].payload).toHaveProperty("postcare_email_failed_at");
  });

  it("the recorded last_error is the fixed safe string, never the provider's text", async () => {
    const chains: Chain[] = [];
    const admin = fakeAdmin({
      appt: ELIGIBLE_APPT,
      claimRows: [{ id: APPOINTMENT_ID }],
      updates: [],
      chains,
    });
    await autoSendPostcareOnComplete(APPOINTMENT_ID, STUDIO_ID, ACTOR, {
      admin,
      sendPostcare: vi
        .fn()
        .mockResolvedValue({ ok: false, retryable: true, error: "SMTP 550 c@example.com" }),
    });
    const recorded = String(chains[2].payload?.postcare_email_last_error ?? "");
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded).not.toContain("SMTP");
    expect(recorded).not.toContain("@example.com");
  });

  it("a load that finds nothing performs no write at all", async () => {
    const chains: Chain[] = [];
    const admin = fakeAdmin({ appt: null, claimRows: [], updates: [], chains });
    expect(
      await autoSendPostcareOnComplete(APPOINTMENT_ID, STUDIO_ID, ACTOR, {
        admin,
        sendPostcare: vi.fn(),
      }),
    ).toBe("load_error");
    expect(chains.filter((c) => c.op === "update")).toHaveLength(0);
  });
});
