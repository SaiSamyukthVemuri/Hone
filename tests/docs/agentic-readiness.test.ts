import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// PR #240, amended 2026-07-27. Docs-only agentic readiness and safety
// plan. These pins keep the safety-critical content of docs/22 from
// eroding: the product principle, the excluded sensitive surfaces, the
// hard prohibitions (no auto-charge, no auto-send, no medical advice, no
// silent clinical mutation), the human-confirmation rule, and that no AI
// runtime is added.
//
// AMENDMENT (2026-07-27): the standing fact "live payments disabled" is
// NO LONGER TRUE and must not be pinned. Live owner-run session payments
// are enabled for approved studios and have been production-exercised
// (Willow Electrolysis: 6 succeeded live-mode charges, most recent
// 2026-07-26). That makes the agentic payment prohibition MORE load-
// bearing, not less: an agent must never create, capture, refund or
// otherwise operate a payment, and explicit human control is mandatory.
// Every prohibition below is preserved unchanged; only the stale
// payments-are-off standing fact is replaced with the controlled-live
// posture.

function readDoc(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
}

const DOC_PATH = "docs/22_AGENTIC_READINESS_AND_SAFETY.md";
const PLAN = readDoc(DOC_PATH);
const HANDOFF = readDoc("docs/14_AI_HANDOFF.md");
const DECISIONS = readDoc("docs/13_BACKLOG_AND_DECISIONS.md");

describe("docs/22 exists and is a plan, not a runtime", () => {
  it("the file is at the expected path", () => {
    expect(
      existsSync(path.resolve(__dirname, "../..", DOC_PATH)),
    ).toBe(true);
  });

  it("states up front that no AI runtime is added", () => {
    expect(PLAN).toMatch(/No AI runtime is added by this document/);
    expect(PLAN).toMatch(/No model is called anywhere in the product/);
  });

  // SUPERSEDED PIN (2026-07-27) — was "states live payments remain disabled",
  // requiring /Live payments remain disabled\./ and
  // /Controlled live payment enablement has not started\./. Both are false:
  // controlled live enablement COMPLETED and live session payments are in use
  // for approved studios. The guard now pins the true, narrower posture.
  it("states the controlled live-payment posture accurately", () => {
    // Enabled — but only for approved studios, never broadly.
    expect(PLAN).toMatch(/enabled for approved studios/i);
    expect(PLAN).toMatch(/production-exercised/i);
    expect(PLAN).toMatch(/broad self-serve/i);
    expect(PLAN).toMatch(/not ready/i);
    // The stale standing facts must not return.
    expect(PLAN).not.toMatch(/Live payments remain disabled\./);
    expect(PLAN).not.toMatch(/Controlled live payment enablement has not started\./);
  });

  it("keeps the agentic payment prohibition absolute regardless of live posture", () => {
    // This is the safety-critical invariant the live posture does NOT relax.
    expect(PLAN).toMatch(/Never auto-charge/);
    expect(PLAN).toMatch(/charge a card/);
    expect(PLAN).toMatch(/create or refund a payment/);
    expect(PLAN).toMatch(/any payment-related action/);
    // No agent path may operate a payment, and human control stays mandatory.
    expect(PLAN).toMatch(/No agent path creates, captures, or refunds a payment/i);
    expect(PLAN).toMatch(/Require human confirmation before any external action/);
  });
});

describe("product principle", () => {
  it("carries the headline framing phrases", () => {
    expect(PLAN).toMatch(/Assistant, not decider/);
    expect(PLAN).toMatch(/Draft, not send/);
    expect(PLAN).toMatch(/Flag, not diagnose/);
    expect(PLAN).toMatch(/Summarize recorded history, do not invent/);
    expect(PLAN).toMatch(/Prepare the practitioner, do not prescribe/);
  });

  it("requires human confirmation and forbids silent mutation / auto actions", () => {
    expect(PLAN).toMatch(/Require human confirmation before any external action/);
    expect(PLAN).toMatch(/Never silently mutate clinical history/);
    expect(PLAN).toMatch(/Never auto-charge/);
    expect(PLAN).toMatch(/Never auto-message clients/);
  });
});

describe("hard prohibitions", () => {
  it("prohibits treatment-setting recommendations as medical advice", () => {
    expect(PLAN).toMatch(/recommend treatment settings as medical advice/);
  });

  it("prohibits diagnosis, causation, and safe/unsafe claims", () => {
    expect(PLAN).toMatch(/claim that anything is safe or unsafe/);
    expect(PLAN).toMatch(/diagnose a condition/);
    expect(PLAN).toMatch(/infer or assert causation/);
  });

  it("prohibits silent clinical record mutation, deletes, auto-send, auto-charge", () => {
    expect(PLAN).toMatch(/modify clinical records silently/);
    expect(PLAN).toMatch(/delete records/);
    expect(PLAN).toMatch(/send a message \(email or SMS\) without explicit confirmation/);
    expect(PLAN).toMatch(/charge a card/);
    expect(PLAN).toMatch(/create or refund a payment/);
  });
});

describe("excluded sensitive surfaces", () => {
  it("excludes exposure incident details and audit payloads", () => {
    expect(PLAN).toMatch(/exposure incident details/);
    expect(PLAN).toMatch(/exposure incident audit payloads/);
    expect(PLAN).toMatch(/owner-tiered/);
  });

  it("excludes payment internals, Stripe ids, and raw tokens", () => {
    expect(PLAN).toMatch(/payment internals/);
    expect(PLAN).toMatch(/Stripe ids/);
    expect(PLAN).toMatch(/raw appointment tokens/);
    expect(PLAN).toMatch(/raw calendar feed tokens/);
    expect(PLAN).toMatch(/auth and session data/);
  });

  it("excludes cross-studio data and anything outside RLS", () => {
    expect(PLAN).toMatch(/cross-studio data of any kind/);
    expect(PLAN).toMatch(/outside the current studio's RLS scope/);
  });
});

describe("human confirmation rules", () => {
  it("requires confirmation for client messages, appointments, records, exports, payments", () => {
    expect(PLAN).toMatch(/sending any client message/);
    expect(PLAN).toMatch(/creating an appointment/);
    expect(PLAN).toMatch(/editing any record/);
    expect(PLAN).toMatch(/marking aftercare \/ risks explained/);
    expect(PLAN).toMatch(/exporting or sending records/);
    expect(PLAN).toMatch(/any payment-related action/);
  });

  it("forbids a blanket approve-everything mode in V1", () => {
    expect(PLAN).toMatch(/blanket "approve everything" mode is not allowed/);
  });
});

describe("safe wording rules", () => {
  it("lists the recorded-history vocabulary to use and the clinical-advice words to avoid", () => {
    for (const use of [
      "last recorded",
      "not recorded",
      "for next visit",
      "may want to review",
      "missing from record",
    ]) {
      expect(PLAN).toMatch(new RegExp(use));
    }
    expect(PLAN).toMatch(/medically necessary/);
    expect(PLAN).toMatch(/clinical advice/);
  });
});

describe("first agentic workflows", () => {
  it("names the first three, in order, read-and-draft only", () => {
    const brief = PLAN.indexOf("Daily Prep Brief V1");
    const missing = PLAN.indexOf("Missing Records / Follow-up Assistant");
    const draft = PLAN.indexOf("Draft-only Client Message Assistant");
    expect(brief).toBeGreaterThan(-1);
    expect(missing).toBeGreaterThan(brief);
    expect(draft).toBeGreaterThan(missing);
    expect(PLAN).toMatch(/never sent without practitioner approval/);
  });
});

describe("security and RLS posture", () => {
  it("inherits studio-scoped access with no broad service-role search and no public endpoints", () => {
    expect(PLAN).toMatch(/same studio-scoped access model/);
    expect(PLAN).toMatch(/No service-role broad AI search/);
    expect(PLAN).toMatch(/No cross-studio memory/);
    expect(PLAN).toMatch(/No public AI endpoints/);
    expect(PLAN).toMatch(/Stripe grep gates/);
  });
});

describe("roadmap docs updated", () => {
  it("docs/14 records the plan as current status with no AI runtime added", () => {
    expect(HANDOFF).toMatch(/Agentic readiness and safety plan/);
    expect(HANDOFF).toMatch(/No AI runtime, model call, endpoint, migration, schema, RLS change, or payment capability is added/);
    expect(HANDOFF).toMatch(/next possible PR is Daily Prep Brief V1/);
  });

  it("docs/13 records the decision that the roadmap starts with a safety plan", () => {
    expect(DECISIONS).toMatch(/Agentic readiness and safety plan \(PR #240, docs-only\)/);
    expect(DECISIONS).toMatch(/starts with a safety plan, not a runtime/);
    // AMENDED 2026-07-27: this previously also required
    // /Live payments remain disabled\./ in docs/13. That string still occurs
    // there, but only inside DATED decision-log entries — it is history, not
    // current state, so pinning it as a standing fact was wrong. docs/13 must
    // instead carry a banner that explicitly disarms those dated entries.
    expect(DECISIONS).toMatch(/point-in-time and superseded/i);
    expect(DECISIONS).toMatch(/Canonical current state/i);
  });
});
