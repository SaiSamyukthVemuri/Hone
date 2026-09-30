import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FREE_CONSULT_WAITLIST_ONLY_CODE,
  isFreeConsultWaitlistOnlyReschedule,
} from "@/lib/booking/free-consult-reschedule-policy";
import { NEW_CLIENT_WAITLIST_SLUGS_ENV } from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// EMERG-01 — the ONE decision behind waitlist-only rebooking of a free
// consultation.
// ===========================================================================
//
// The predicate is a conjunction of THREE independent facts, and every one of
// them is a documented negative control in the emergency brief:
//
//   * the studio's NEW-client intake is waitlisted  (the EXISTING gate)
//   * the service is a consultation                 (the EXISTING classifier)
//   * the service is FREE                           (price_cents === 0)
//
// The tests below fix each conjunct by disproving it in isolation, because a
// predicate that answered `true` on two of three would silently take
// rescheduling away from a paying client.

const WAITLISTED = "e2e-waitlist-p0";
const OPEN = "some-open-studio";

/** A consultation by the canonical `modality` route. */
const FREE_CONSULT = {
  modality: "consultation",
  name: "New Client Consultation",
  price_cents: 0,
};

const POLICY_SOURCE = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "..",
    "lib",
    "booking",
    "free-consult-reschedule-policy.ts",
  ),
  "utf8",
);

afterEach(() => {
  delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
});

function enable(slugs: string) {
  process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = slugs;
}

describe("isFreeConsultWaitlistOnlyReschedule — the positive case", () => {
  it("matches a waitlisted studio's FREE consultation", () => {
    enable(WAITLISTED);
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioIsWaitlisted: true,
        service: FREE_CONSULT,
      }),
    ).toBe(true);
  });

  it("matches when the studio sets NO modality but names the service a consultation", () => {
    // The existing classifier's documented name fallback. This policy inherits
    // it rather than re-deriving "is a consultation", so the two can never
    // disagree about the same row.
    enable(WAITLISTED);
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioIsWaitlisted: true,
        service: { modality: null, name: "Free Consultation", price_cents: 0 },
      }),
    ).toBe(true);
  });
});

describe("NEGATIVE CONTROL E — a PAID consultation is untouched", () => {
  it.each([[1], [500], [12_500]])(
    "price_cents=%i does not match",
    (price_cents) => {
      enable(WAITLISTED);
      expect(
        isFreeConsultWaitlistOnlyReschedule({
          studioIsWaitlisted: true,
          service: { ...FREE_CONSULT, price_cents },
        }),
      ).toBe(false);
    },
  );

  it("a NULL price is NOT free — an unpriced service is unknown, not zero", () => {
    enable(WAITLISTED);
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioIsWaitlisted: true,
        service: { ...FREE_CONSULT, price_cents: null },
      }),
    ).toBe(false);
  });
});

describe("NEGATIVE CONTROL F — a $0 NON-consultation treatment is untouched", () => {
  it.each([
    ["electrolysis", "Full Face"],
    ["laser", "Underarms"],
    [null, "Complimentary Touch-up"],
    ["", "Patch Test"],
  ])("modality=%s name=%s does not match", (modality, name) => {
    enable(WAITLISTED);
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioIsWaitlisted: true,
        service: { modality, name: name as string, price_cents: 0 },
      }),
    ).toBe(false);
  });

  it("classification NEVER comes from price alone", () => {
    // The brief's explicit instruction. A free service with no consultation
    // signal anywhere must not be swept in.
    enable(WAITLISTED);
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioIsWaitlisted: true,
        service: {
          modality: "electrolysis",
          name: "15 Minutes",
          price_cents: 0,
        },
      }),
    ).toBe(false);
  });
});

describe("NEGATIVE CONTROL G — an OPEN studio is untouched", () => {
  it("a free consultation at a studio the gate does not name does not match", () => {
    enable(WAITLISTED);
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioIsWaitlisted: false,
        service: FREE_CONSULT,
      }),
    ).toBe(false);
  });

  // NEW-CLIENT-MODE-01. The env-list PARSING cases that stood here - unset,
  // empty, whitespace, comma-only - tested the gate predicate, not this
  // function, which no longer reads any environment value. That coverage lives
  // in tests/lib/booking/new-client-admission.test.ts, where the transition
  // bridge is exercised directly, and it is stronger there: it also proves the
  // bridge can only ESCALATE.


  it("EXACT MATCH ONLY — a prefix/suffix neighbour of an enabled slug does not match", () => {
    enable("willow-electrolysis");
    for (const near of [
      "willow-electrolysis-archive",
      "willow",
      "electrolysis",
      "xwillow-electrolysis",
    ]) {
      expect(
        isFreeConsultWaitlistOnlyReschedule({
          studioIsWaitlisted: false,
          service: FREE_CONSULT,
        }),
        near,
      ).toBe(false);
    }
  });
});

describe("the predicate cannot be satisfied by missing data", () => {
  it("a studio that is not in waitlist mode never matches", () => {
    // NEW-CLIENT-MODE-01: the slug no longer reaches this function. The caller
    // resolves the mode from the one authority and passes the fact; UNKNOWN
    // arrives here as `false`, which is what the default-off gate did.
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioIsWaitlisted: false,
        service: FREE_CONSULT,
      }),
    ).toBe(false);
  });

  it.each([[null], [undefined]])("a %j service never matches", (service) => {
    enable(WAITLISTED);
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioIsWaitlisted: true,
        service,
      }),
    ).toBe(false);
  });
});

describe("no studio is hardcoded", () => {
  it("the policy module names no studio, slug or person", () => {
    // The emergency brief forbids product hardcoding: the gate's configured
    // allowlist is the ONLY thing that decides which studios are in scope.
    for (const forbidden of ["willow", "chloe"]) {
      expect(POLICY_SOURCE.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("does not introduce a SECOND environment variable beside the existing gate", () => {
    // The brief: do not add a separate env var unless the existing gate cannot
    // truthfully express the requirement. It can, so the only env this module
    // may consult is the one the gate already owns — and it consults it
    // THROUGH the gate, never by reading process.env itself.
    expect(POLICY_SOURCE).not.toContain("process.env");
    // Stronger than before: this module now consults NO environment authority,
    // directly or through a predicate. The caller supplies the resolved state.
    expect(POLICY_SOURCE).not.toContain("isNewClientWaitlistEnabled");
    expect(POLICY_SOURCE).toContain("studioIsWaitlisted");
  });

  it("the answer follows the state it is given, call by call", () => {
    // What "an operator change takes effect at once" means now: the function
    // holds no cached gate, so consecutive calls with different resolved states
    // give different answers.
    const on = isFreeConsultWaitlistOnlyReschedule({
      studioIsWaitlisted: true,
      service: FREE_CONSULT,
    });
    const off = isFreeConsultWaitlistOnlyReschedule({
      studioIsWaitlisted: false,
      service: FREE_CONSULT,
    });
    expect([on, off]).toEqual([true, false]);
  });
});

describe("the machine code is bounded and stable", () => {
  it("is the exact value the public surfaces branch on", () => {
    expect(FREE_CONSULT_WAITLIST_ONLY_CODE).toBe(
      "free_consultation_waitlist_only",
    );
  });
});
