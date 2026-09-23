import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildGettingStarted,
  type ChecklistItem,
  type GettingStartedSignals,
} from "@/lib/onboarding/getting-started";
import { CONSENT_SETTINGS_HREF } from "@/lib/consent/launch-readiness";

// F-CONSENT-GAP, consumer side. The RULE is proved behaviourally in
// tests/lib/consent/launch-readiness.test.ts; this file proves that BOTH
// readiness surfaces consume that one rule and neither re-derives it.
//
// The getting-started assertions are behavioural (buildGettingStarted is pure).
// The launch checklist builds its rows inside an async server component, so its
// assertions are source contracts — narrow ones: which module it calls, which
// route it links to, and that it does NOT carry a second copy of the predicate.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const LAUNCH = read("app/(app)/settings/launch/page.tsx");
const GETTING_STARTED = read("lib/onboarding/getting-started.ts");
const CANONICAL = read("lib/booking/new-client-readiness.ts");

const CONSENT_ITEM_KEY = "treatment-consent";

function signals(
  over: Partial<GettingStartedSignals> = {},
): GettingStartedSignals {
  return {
    studioName: "Studio A",
    practitionerName: "Owner",
    hasSlug: true,
    activeServices: 1,
    appointments: 1,
    clients: 1,
    sessions: 1,
    treatmentAreas: 1,
    hasFrequency: true,
    hasProbe: true,
    hasProbeLot: true,
    hasReactionOrTolerance: true,
    hasNextVisitNote: true,
    liveTreatmentConsent: true,
    sterileItems: 1,
    disinfectants: 1,
    paymentAttempts: 1,
    runtimeLivemode: false,
    // Default: every signal read succeeded. Read-failure behaviour is pinned
    // in tests/lib/onboarding/next-setup-step.test.ts.
    nextStepSignalsAvailable: true,
    ...over,
  };
}

/**
 * The launch checklist's consent row literal, as written in the page.
 *
 * The page builds its rows inside an async server component, so the row cannot
 * be imported. Slicing the literal keeps the copy assertions pointed at what an
 * owner reads instead of at the file's comments.
 */
function launchConsentRow(): string {
  const start = LAUNCH.indexOf('title: "Treatment consent form"');
  expect(start, "the consent row is missing from the launch checklist").toBeGreaterThan(-1);
  const end = LAUNCH.indexOf("\n    },", start);
  expect(end, "the consent row literal is unterminated").toBeGreaterThan(start);
  return LAUNCH.slice(start, end);
}

function consentItem(over: Partial<GettingStartedSignals>): ChecklistItem {
  const item = buildGettingStarted(signals(over))
    .sections.flatMap((s) => s.items)
    .find((i) => i.key === CONSENT_ITEM_KEY);
  if (!item) throw new Error("consent readiness item is missing entirely");
  return item;
}

describe("getting-started uses the same rule (CASE 5)", () => {
  it("zero live consent => NOT ready (todo)", () => {
    expect(consentItem({ liveTreatmentConsent: false }).status).toBe("todo");
  });

  it("one live treatment consent => READY (done)", () => {
    expect(consentItem({ liveTreatmentConsent: true }).status).toBe("done");
  });

  it("an unreadable count is a review item, never a silent 'done'", () => {
    // Collapsing null to true would green-light a launch on no evidence;
    // collapsing it to false would tell the owner to build what they have.
    const item = consentItem({ liveTreatmentConsent: null });
    expect(item.status).toBe("review");
    expect(item.status).not.toBe("done");
  });

  it("the item links to the real consent settings route (CASE 6)", () => {
    for (const value of [true, false, null] as const) {
      expect(consentItem({ liveTreatmentConsent: value }).href).toBe(
        CONSENT_SETTINGS_HREF,
      );
    }
    expect(CONSENT_SETTINGS_HREF).toBe("/settings/consent");
  });

  it("it is auto-detected, so it moves the honest progress counter", () => {
    const ready = buildGettingStarted(signals({ liveTreatmentConsent: true }));
    const notReady = buildGettingStarted(
      signals({ liveTreatmentConsent: false }),
    );
    expect(notReady.autoTotal).toBe(ready.autoTotal);
    expect(notReady.autoDone).toBe(ready.autoDone - 1);
  });

  it("an unreadable count leaves the auto counter honest (review is excluded)", () => {
    const unknown = buildGettingStarted(
      signals({ liveTreatmentConsent: null }),
    );
    const ready = buildGettingStarted(signals({ liveTreatmentConsent: true }));
    // A fact we could not establish is not counted as done, and is not counted
    // as an outstanding auto task either.
    expect(unknown.autoTotal).toBe(ready.autoTotal - 1);
    expect(unknown.autoDone).toBe(ready.autoDone - 1);
  });

  it("changing consent readiness changes nothing else on the checklist", () => {
    // Guards the "did any unrelated onboarding behaviour change?" question:
    // every other item must be byte-identical across the two states.
    const others = (v: boolean) =>
      buildGettingStarted(signals({ liveTreatmentConsent: v }))
        .sections.flatMap((s) => s.items)
        .filter((i) => i.key !== CONSENT_ITEM_KEY);
    expect(others(false)).toEqual(others(true));
  });
});

describe("launch checklist surfaces consent readiness", () => {
  it("reaches the shared authority — now through the canonical readiness module", () => {
    // ONB-02 P1 moved the CALL, not the rule. The launch page stopped loading
    // consent itself so that one module answers "can this studio accept a new
    // client right now?"; the chain to the one consent authority is unbroken
    // and is asserted end to end rather than at the old call site.
    expect(LAUNCH).toContain("getNewClientReadiness");
    expect(CANONICAL).toContain("getTreatmentConsentReadiness");
    expect(CANONICAL).toMatch(/from "@\/lib\/consent\/launch-readiness"/);
  });

  it("has a consent row that links to the real consent settings route", () => {
    expect(LAUNCH).toContain('title: "Treatment consent form"');
    expect(LAUNCH).toContain("href: CONSENT_SETTINGS_HREF");
  });

  it("renders three distinct states, and never claims ready on an unknown", () => {
    // The row still reads a result-bearing shape rather than a bare boolean;
    // the shape is now the canonical verdict's, so UNKNOWN arrives as an
    // unavailable AUTHORITY and NOT_READY as a PROVEN blocker.
    expect(LAUNCH).toContain('unavailableAuthorities.has("treatment_consent")');
    expect(LAUNCH).toContain('provenBlockers.has("treatment_consent")');
    expect(LAUNCH).toContain('"unknown"');
    // and the canonical module keeps consent's own three-state shape intact
    expect(CANONICAL).toContain("treatmentConsent.ok");
    // "unknown" is not counted as ready, and not counted as to-do.
    expect(LAUNCH).toContain('r.status === "ready"');
    expect(LAUNCH).toContain('r.status === "needs_setup"');
  });

  it("tells the owner what to do next, in product terminology", () => {
    expect(LAUNCH).toContain("Create a treatment consent form and make it live");
    // "Consent forms" is the settings nav label; the copy must match it.
    expect(LAUNCH).toContain("Open Consent forms");
    expect(read("app/(app)/settings/layout.tsx")).toContain(
      'label: "Consent forms"',
    );
  });

  it("issues the readiness read alongside the existing ones, not after them", () => {
    // The reads moved into the canonical module, so the no-extra-round-trip
    // invariant is asserted where they now live. The launch page issues ONE
    // await for all of them, which is strictly fewer round trips than before.
    const block = CANONICAL.slice(
      CANONICAL.indexOf("await Promise.all"),
      CANONICAL.indexOf("]);", CANONICAL.indexOf("await Promise.all")),
    );
    expect(block).toContain("getTreatmentConsentReadiness(studio.id)");
    expect(block).toContain("getActiveServices(studio.id)");
  });
});

describe("ONE authority — the rule cannot drift between the two surfaces", () => {
  const CONSUMERS: Array<[string, string]> = [
    ["launch checklist", LAUNCH],
    ["getting-started", GETTING_STARTED],
    // ONB-02: the canonical authority is a consumer of the consent rule too,
    // and is held to the same no-re-derivation bar as the surfaces.
    ["canonical readiness", CANONICAL],
  ];

  it("neither consumer queries consent_form_templates itself", () => {
    for (const [name, src] of CONSUMERS) {
      expect(src, `${name} must not query consent templates directly`).not.toContain(
        "consent_form_templates",
      );
    }
  });

  it("neither consumer re-states the qualifying predicate", () => {
    // The four filters live in exactly one module. A second copy is how the
    // launch checklist and getting-started would start disagreeing about
    // whether the same studio is ready.
    for (const [name, src] of CONSUMERS) {
      expect(src, `${name} must not re-state is_live`).not.toContain("is_live");
      // The PREDICATE's fingerprint is the column it filters on. The bare
      // literal is no longer sufficient evidence of a re-statement: ONB-02
      // gives the launch page a readiness KEY spelled the same way, which
      // filters nothing and queries nothing. `form_type` cannot appear except
      // in a re-stated query, so it is the precise test — and `is_live` plus
      // `consent_form_templates` above still fence the same drift.
      expect(src, `${name} must not re-state the form type filter`).not.toContain(
        "form_type",
      );
    }
  });

  it("every consumer imports the shared module, none re-implements it", () => {
    for (const [name, src] of CONSUMERS) {
      expect(src, `${name} must import the shared authority`).toMatch(
        /from "@\/lib\/consent\/launch-readiness"/,
      );
    }
  });
});

describe("no legal-compliance claim, and no consent content in code", () => {
  const SOURCES = [
    LAUNCH,
    GETTING_STARTED,
    read("lib/consent/launch-readiness.ts"),
  ];

  it("never claims the studio is compliant, legal, or enforceable", () => {
    // Scoped to copy an OWNER CAN ACTUALLY READ, not to the whole file: a
    // comment saying "this is NOT a legal claim" is the opposite of the defect,
    // and a whole-file grep would flag the disclaimer along with the claim.
    const ownerCopy = [
      // Behavioural: the real rendered strings, in all three states.
      ...[true, false, null].flatMap((v) => {
        const item = consentItem({ liveTreatmentConsent: v });
        return [item.label, item.explanation];
      }),
      // The launch checklist's consent row literal.
      launchConsentRow(),
    ].join("\n");

    expect(ownerCopy).not.toMatch(/legal|complian|binding|enforceab|lawyer/i);
    // And it does say the operative, honest thing.
    expect(ownerCopy).toMatch(/consent/i);
  });

  it("ships no consent template body, title or legal wording", () => {
    for (const src of SOURCES) {
      expect(src).not.toMatch(/I (consent|understand|agree) to/i);
      expect(src).not.toMatch(/permanently removes hair/i);
    }
  });

  it("creates no consent template anywhere in the readiness path", () => {
    for (const src of SOURCES) {
      expect(src).not.toMatch(/\.insert\(/);
      expect(src).not.toMatch(/\.upsert\(/);
      expect(src).not.toMatch(/\.update\(/);
    }
  });
});
