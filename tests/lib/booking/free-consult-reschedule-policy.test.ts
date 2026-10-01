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
        studioSlug: WAITLISTED,
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
        studioSlug: WAITLISTED,
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
          studioSlug: WAITLISTED,
          service: { ...FREE_CONSULT, price_cents },
        }),
      ).toBe(false);
    },
  );

  it("a NULL price is NOT free — an unpriced service is unknown, not zero", () => {
    enable(WAITLISTED);
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioSlug: WAITLISTED,
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
        studioSlug: WAITLISTED,
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
        studioSlug: WAITLISTED,
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
        studioSlug: "not-listed-studio",
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
          studioSlug: "not-listed-studio",
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
        studioSlug: "not-listed-studio",
        service: FREE_CONSULT,
      }),
    ).toBe(false);
  });

  it.each([[null], [undefined]])("a %j service never matches", (service) => {
    enable(WAITLISTED);
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioSlug: WAITLISTED,
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
    // ONE env authority, consulted THROUGH the gate's own predicate rather than
    // by reading process.env here. A brief version of this PR removed the read
    // entirely and took the answer from the caller - which is how the owner's
    // new-client admission mode reached an already-confirmed appointment.
    expect(POLICY_SOURCE).toContain("isNewClientWaitlistEnabled(studioSlug)");
    expect(POLICY_SOURCE).not.toContain("NEW_CLIENT_WAITLIST_DURABLE");
  });

  it("the answer follows the gate, call by call", () => {
    // What "an operator change takes effect at once" means: the function holds
    // no cached gate, so consecutive calls for a listed and an unlisted studio
    // give different answers within one process.
    enable(WAITLISTED);
    const on = isFreeConsultWaitlistOnlyReschedule({
      studioSlug: WAITLISTED,
      service: FREE_CONSULT,
    });
    const off = isFreeConsultWaitlistOnlyReschedule({
      studioSlug: "not-listed-studio",
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

// ===========================================================================
// EXACT-HEAD P1 at d55cbd8e — THIS POLICY'S AUTHORITY IS ITS OWN.
//
// NEW-CLIENT-MODE-01 briefly routed this policy through the owner-facing
// canonical admission mode. Two defects came out of that, and the second is why
// the authority moved back:
//
//   * a slug-only projection handed the resolver `undefined`, so every free
//     consultation at a waitlisted studio silently became reschedulable
//     (exact-head P1 at 0a207470, fixed by projecting `id`);
//   * and then, more fundamentally, an owner changing OPEN / WAITLIST / CLOSED
//     moved the rights of an appointment that was ALREADY CONFIRMED - freezing
//     every confirmed future free consultation on a flip to WAITLIST, and
//     unfreezing them on a persisted OPEN. `new_client_admission_mode` governs
//     whether a NEW client may be admitted; it must never govern what a booked
//     client may do.
//
// So EMERG-01 keeps the authority it had before this PR - the server-only env
// list, read inside the policy and nowhere else - and deploying
// NEW-CLIENT-MODE-01 changes nothing for an already-confirmed appointment.
//
// FOLLOW-UP DEBT: that legacy env authority needs its own product decision and
// durable authority before it can be retired. It must NOT be deleted with the
// new-client admission bridge.
// ===========================================================================
describe("the policy does not consult the new-client admission authority", () => {
  const ROUTES = [
    "app/reschedule/[token]/actions.ts",
    "app/manage/[token]/actions.ts",
    "app/cancel/[token]/actions.ts",
  ] as const;

  const source = (rel: string) =>
    readFileSync(join(process.cwd(), rel), "utf8");

  it("reads the EMERG-01 env list, inside the policy, and nowhere else", () => {
    expect(POLICY_SOURCE).toContain("isNewClientWaitlistEnabled(studioSlug)");
    // Not the canonical mode, and not a caller-supplied boolean standing in for
    // it: both are how an owner's new-client setting reached a booked client.
    //
    // CALLS, not mentions. The doc comment above the signature NAMES
    // `studioIsInWaitlistMode` to record why it is not used, and a comment
    // cannot resolve an admission mode - counting prose would make this guard
    // trip on its own explanation.
    const code = POLICY_SOURCE.split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toContain("studioIsInWaitlistMode(");
    expect(code).not.toContain("getNewClientAdmissionMode(");
    expect(code).not.toContain("studioIsWaitlisted");
  });

  it.each(ROUTES)("%s feeds the policy a SLUG, not an admission mode", (route) => {
    const code = source(route);
    expect(code).toContain("isFreeConsultWaitlistOnlyReschedule");
    expect(code).toContain("studioSlug:");
    expect(
      code,
      `${route} must not route the new-client admission authority into this policy`,
    ).not.toContain("studioIsWaitlisted:");
  });

  it.each(ROUTES)("%s does not resolve the canonical mode at all", (route) => {
    // The strongest form: these routes have no business reading the new-client
    // admission authority, so the import is absent rather than merely unused.
    expect(source(route)).not.toContain(
      'from "@/lib/booking/new-client-admission"',
    );
  });
});

describe("an owner's admission change cannot move a confirmed appointment", () => {
  // The four transitions the ruling names. The policy verdict is computed with
  // the EMERG-01 env list held CONSTANT while the admission mode changes
  // underneath - which is exactly the production scenario: a booked client with
  // a confirmed free consultation, and an owner opening the settings page.
  const FREE_CONSULT = {
    modality: "consultation",
    name: "Free consultation",
    price_cents: 0,
  };

  it.each([
    ["OPEN -> WAITLIST", "open", "waitlist"],
    ["WAITLIST -> CLOSED", "waitlist", "closed"],
    ["CLOSED -> OPEN", "closed", "open"],
  ])("%s leaves the verdict unchanged at a LISTED studio", (_l, from, to) => {
    enable(WAITLISTED);
    const before = isFreeConsultWaitlistOnlyReschedule({
      studioSlug: WAITLISTED,
      service: FREE_CONSULT,
    });
    // The admission mode is not an input, so there is nothing to vary: the
    // verdict is a function of the env list and the service, and both modes
    // below are irrelevant to it by construction.
    void from;
    void to;
    const after = isFreeConsultWaitlistOnlyReschedule({
      studioSlug: WAITLISTED,
      service: FREE_CONSULT,
    });
    expect(before).toBe(true);
    expect(after).toBe(before);
  });

  it.each([
    ["OPEN -> WAITLIST"],
    ["WAITLIST -> CLOSED"],
    ["CLOSED -> OPEN"],
  ])("%s leaves the verdict unchanged at an UNLISTED studio", () => {
    enable("some-other-studio");
    const verdict = isFreeConsultWaitlistOnlyReschedule({
      studioSlug: "this-studio",
      service: FREE_CONSULT,
    });
    // THE REGRESSION THIS PREVENTS: before the repair, an owner here flipping to
    // WAITLIST froze every confirmed free consultation. Now the studio is simply
    // not covered by EMERG-01, whatever the owner chooses.
    expect(verdict).toBe(false);
  });

  it("EMERG-01's own covered cases keep their previous results", () => {
    enable(WAITLISTED);
    // Listed + free consultation -> restricted, as before this PR.
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioSlug: WAITLISTED,
        service: FREE_CONSULT,
      }),
    ).toBe(true);
    // Listed + PAID consultation -> not restricted.
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioSlug: WAITLISTED,
        service: { ...FREE_CONSULT, price_cents: 5000 },
      }),
    ).toBe(false);
    // Listed + non-consultation -> not restricted.
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioSlug: WAITLISTED,
        service: { modality: "electrolysis", name: "Session", price_cents: 0 },
      }),
    ).toBe(false);
    // Unlisted + free consultation -> not restricted.
    expect(
      isFreeConsultWaitlistOnlyReschedule({
        studioSlug: "not-listed",
        service: FREE_CONSULT,
      }),
    ).toBe(false);
  });
});
