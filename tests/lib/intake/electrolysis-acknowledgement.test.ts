import { describe, expect, it } from "vitest";
import {
  ACKNOWLEDGEMENT_REVIEW_COPY,
  ELECTROLYSIS_ACKNOWLEDGEMENT,
  normalizeElectrolysisAcknowledgementClaim,
  readElectrolysisAcknowledgement,
} from "@/lib/intake/acknowledgements";
import {
  ALL_QUESTION_KEYS,
  findMissingRequiredAnswers,
  INTAKE_STEPS,
  isClientOwnedResponseKey,
} from "@/lib/intake/questions";

// Versioned electrolysis acknowledgement — the shared contract.
//
// These are real behavioural tests of a pure module, not source greps: the
// forgery cases below call the actual validator the submit boundary calls.
// The wiring that connects this module to the public action, the wizard and
// the practitioner review surface is pinned separately in
// tests/app/intake/electrolysis-acknowledgement-wiring.test.ts.

const CANON = ELECTROLYSIS_ACKNOWLEDGEMENT;
const NOW = "2026-08-06T12:00:00.000Z";

// A responses map that satisfies every required question, so the tests
// below isolate the acknowledgement rather than tripping over an unrelated
// missing answer. Built from INTAKE_STEPS so it cannot drift.
function completeResponses(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const step of INTAKE_STEPS) {
    for (const q of step.questions) {
      if (!q.required) continue;
      if (q.conditional) continue; // conditionally hidden = not missing
      if (q.type === "multi_select") out[q.key] = [q.options?.[0]?.value ?? "x"];
      else if (q.type === "checkbox") out[q.key] = true;
      else if (q.type === "single_select") out[q.key] = q.options?.[0]?.value ?? "x";
      else if (q.type === "yes_no") out[q.key] = "no";
      else if (q.type === "date") out[q.key] = "1990-01-01";
      else out[q.key] = "provided";
    }
  }
  // RETIRED (#518): the acknowledgement claim used to be attached here.
  return { ...out, ...overrides };
}

describe("1. shared ID / version / wording contract", () => {
  it("exposes a stable id, a version, and non-empty wording", () => {
    expect(CANON.id).toBe("electrolysis_acknowledgement");
    expect(CANON.version).toBe("v1");
    expect(CANON.wording.length).toBeGreaterThan(80);
    expect(CANON.helpText.length).toBeGreaterThan(20);
  });

  // The wording literal is pinned so an edit cannot land without a
  // deliberate decision about the version. `wording` and `version` move
  // together; changing one without the other turns this red, which is the
  // whole point — a silent wording edit would make an older acceptance
  // look current.
  it("pins the exact wording, so any edit must consciously bump the version", () => {
    // ⚠️ THE VERSION AND THE WORDING ARE ONE UNIT. If you are editing the
    // literal below because the wording changed, you MUST also bump
    // ELECTROLYSIS_ACKNOWLEDGEMENT.version and the pin in the test above.
    // Shipping new wording under an old version would make an acceptance of
    // the OLD text validate as if the client had read the NEW text.
    expect(CANON.version).toBe("v1");
    expect(CANON.wording).toBe(
      "I understand that electrolysis is a course of treatment rather than a single appointment: hair is treated one follicle at a time, permanent results build over a series of sessions spaced across months, and the number of sessions varies from person to person. I understand that treatment involves some sensation, that temporary skin reactions such as redness or swelling can follow a session, and that my electrologist will talk through what to expect for my own skin and hair.",
    );
  });

  it("keeps the checkbox key DISTINCT from the provenance record key", () => {
    // A collision would make the object overwrite the boolean, and
    // findMissingRequiredAnswers (checkbox requires `=== true`) would then
    // reject every submission forever.
    expect(CANON.questionKey).not.toBe(CANON.id);
    expect(CANON.questionKey).toBe("ack_electrolysis_nature");
  });

  it("describes the nature of electrolysis, not an agreement to treatment", () => {
    const w = CANON.wording.toLowerCase();
    expect(w).toContain("course of treatment");
    expect(w).toContain("series of sessions");
    expect(w).toContain("varies from person to person");
    expect(w).toContain("sensation");
  });

  it("is framed as an acknowledgement, never as a signature or a consent form", () => {
    // The text the client agrees to must contain no signature language at
    // all — this is a checkbox, not an e-signature.
    expect(CANON.wording.toLowerCase()).not.toMatch(/\bsign/);
    expect(CANON.wording.toLowerCase()).not.toMatch(/\bconsent\b/);
    // The help text names both boundaries explicitly, and those denials are
    // the ONLY place either word may appear.
    const help = CANON.helpText.toLowerCase();
    expect(help).toContain("not a signature");
    expect(help).toContain("not a consent form");
    const helpMinusDenials = help
      .replace("not a signature", "")
      .replace("not a consent form", "");
    expect(helpMinusDenials).not.toMatch(/\bsign/);
  });
});

describe("11 + 12. practitioner review projection", () => {
  it("11. shows the stored wording and version for an acknowledged intake", () => {
    const responses = {
      [CANON.questionKey]: true,
      [CANON.id]: {
        id: CANON.id,
        version: CANON.version,
        wording: CANON.wording,
        accepted: true,
        accepted_at: NOW,
      },
    };
    const view = readElectrolysisAcknowledgement(responses, "submitted");
    expect(view.state).toBe("acknowledged");
    expect(view.state === "acknowledged" && view.wording).toBe(CANON.wording);
    expect(view.state === "acknowledged" && view.version).toBe(CANON.version);
    expect(view.state === "acknowledged" && view.acceptedAtIso).toBe(NOW);
  });

  it("11b. renders the SNAPSHOT the client read, not the current wording", () => {
    // A past client who accepted v1 must keep being shown v1 after the
    // constant is edited. The read side reports the stored text verbatim.
    const historical = {
      [CANON.questionKey]: true,
      [CANON.id]: {
        id: CANON.id,
        version: "v0",
        wording: "An older wording the client actually read.",
        accepted: true,
        accepted_at: NOW,
      },
    };
    const view = readElectrolysisAcknowledgement(historical, "reviewed");
    expect(view.state).toBe("acknowledged");
    expect(view.state === "acknowledged" && view.wording).toBe(
      "An older wording the client actually read.",
    );
    expect(view.state === "acknowledged" && view.version).toBe("v0");
  });

  it("12. a legacy submitted intake is described truthfully, never as declined", () => {
    for (const status of ["submitted", "reviewed"] as const) {
      const view = readElectrolysisAcknowledgement({ legal_name: "A" }, status);
      expect(view.state).toBe("not_recorded");
    }
    // Neutral and provable. The old copy asserted the intake "predates" the
    // acknowledgement, which retirement made unprovable: an intake submitted
    // today also carries no record.
    expect(ACKNOWLEDGEMENT_REVIEW_COPY.notRecorded).toBe(
      "No versioned electrolysis acknowledgement was recorded with this intake.",
    );
  });

  it("12b. an in-progress intake with no record is NOT called 'predates'", () => {
    const view = readElectrolysisAcknowledgement({ legal_name: "A" }, "in_progress");
    expect(view.state).toBe("no_record");
  });

  it("12b-ii. the no-record copy claims nothing about how far the client got", () => {
    // A client who reached the last step, read the wording and chose NOT to
    // tick it stores no record — identical to a client who never got there.
    // The copy must therefore describe the record, not the client. Pinned
    // because an earlier draft said "has not got to the acknowledgement
    // step", which is false in the read-then-declined case.
    const copy = ACKNOWLEDGEMENT_REVIEW_COPY.noRecord;
    expect(copy).toBe("No acknowledgement recorded. This intake is still in progress.");
    expect(copy).not.toMatch(/not (yet )?reached|has not got to|did not (see|read)/i);
  });

  it("12c. an unticked record reads as not acknowledged, with its wording", () => {
    // Written as a literal, because the builder that used to produce this is
    // retired — but rows of exactly this shape are still in the database and
    // must keep reading correctly forever.
    const view = readElectrolysisAcknowledgement(
      {
        [CANON.id]: {
          id: CANON.id,
          version: CANON.version,
          wording: CANON.wording,
          accepted: false,
        },
      },
      "in_progress",
    );
    expect(view.state).toBe("not_acknowledged");
    expect(view.state === "not_acknowledged" && view.wording).toBe(CANON.wording);
  });

  it("12d. a malformed record is reported unreadable, never as an acceptance", () => {
    for (const bad of ["yes", 7, [], { accepted: true }, { id: "other", version: "v1", wording: "w", accepted: true }]) {
      const view = readElectrolysisAcknowledgement({ [CANON.id]: bad }, "submitted");
      expect(view.state, JSON.stringify(bad)).toBe("unreadable");
    }
  });

  it("12e. never throws on a legacy, empty, or malformed responses map", () => {
    for (const map of [null, undefined, {}, [] as unknown as Record<string, unknown>]) {
      expect(() =>
        readElectrolysisAcknowledgement(map as never, "submitted"),
      ).not.toThrow();
    }
  });

  it("12f. review copy carries no verdict language and no signature language", () => {
    const copy = Object.values(ACKNOWLEDGEMENT_REVIEW_COPY).join(" ");
    for (const forbidden of [
      /\bsafe\b/i,
      /\bunsafe\b/i,
      /\bcleared\b/i,
      /\bapproved\b/i,
      /contraindicat/i,
      /diagnos/i,
      /\bsigned\b/i,
      /\bsignature\b(?! and not)/i,
    ]) {
      expect(copy, `matched ${forbidden}`).not.toMatch(forbidden);
    }
    // The one place "signature" may appear is the boundary statement.
    expect(ACKNOWLEDGEMENT_REVIEW_COPY.caveat).toContain("not a signature");
  });
});

describe("normalizer hardening", () => {
  it("drops unknown fields and keeps only the four claim fields", () => {
    const c = normalizeElectrolysisAcknowledgementClaim({
      id: "a",
      version: "b",
      wording: "c",
      accepted: true,
      injected: "x",
      accepted_at: "1999",
    });
    expect(Object.keys(c ?? {}).sort()).toEqual([
      "accepted",
      "id",
      "version",
      "wording",
    ]);
  });

  it("rejects non-string or oversize fields", () => {
    expect(
      normalizeElectrolysisAcknowledgementClaim({ id: 1, version: "v1", wording: "w", accepted: true }),
    ).toBeNull();
    expect(
      normalizeElectrolysisAcknowledgementClaim({
        id: "a",
        version: "v1",
        wording: "x".repeat(4001),
        accepted: true,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RETIREMENT
// ---------------------------------------------------------------------------
//
// #529 shipped the studio's real live consent forms inside the intake, so this
// temporary acknowledgement is no longer collected. These pins prove the
// collection side is genuinely gone — not merely hidden — while the read side
// above keeps historical evidence intact.
describe("retirement — nothing new is collected", () => {
  it("the acknowledgement is no longer a question on any step", () => {
    const keys = INTAKE_STEPS.flatMap((s) => s.questions.map((q) => q.key));
    expect(keys).not.toContain(CANON.questionKey);
    expect(ALL_QUESTION_KEYS).not.toContain(CANON.questionKey);
  });

  it("it is therefore never a missing REQUIRED answer", () => {
    // A response map with every other required answer must not be blocked by
    // the retired checkbox.
    const answers: Record<string, unknown> = {};
    for (const step of INTAKE_STEPS) {
      for (const q of step.questions) {
        if (!q.required || q.conditional) continue;
        if (q.type === "multi_select") answers[q.key] = ["x"];
        else if (q.type === "checkbox") answers[q.key] = true;
        else if (q.type === "single_select") answers[q.key] = q.options?.[0]?.value ?? "x";
        else if (q.type === "yes_no") answers[q.key] = "no";
        else if (q.type === "date") answers[q.key] = "1990-01-01";
        else answers[q.key] = "provided";
      }
    }
    const missing = findMissingRequiredAnswers(answers);
    expect(missing).not.toContain(CANON.questionKey);
    expect(missing).toEqual([]);
  });

  it("the WRITE-side helpers are gone from the module surface", async () => {
    // Leaving a claim builder / draft builder / submit validator exported for
    // a retired collection is an invitation to re-wire it.
    const mod = await import("@/lib/intake/acknowledgements");
    expect(mod).not.toHaveProperty("buildElectrolysisAcknowledgementClaim");
    expect(mod).not.toHaveProperty("buildElectrolysisAcknowledgementDraftRecord");
    expect(mod).not.toHaveProperty("validateElectrolysisAcknowledgement");
    // ...and the read side is still exported.
    expect(typeof mod.readElectrolysisAcknowledgement).toBe("function");
  });

  it("BOTH legacy keys stay client-owned, so a practitioner cannot alter them", () => {
    // Load-bearing: removing the question dropped questionKey out of the
    // DERIVED client-owned set. If it were not named explicitly, retirement
    // would have made a historical client answer practitioner-writable.
    expect(isClientOwnedResponseKey(CANON.questionKey)).toBe(true);
    expect(isClientOwnedResponseKey(`${CANON.questionKey}_notes`)).toBe(true);
    expect(isClientOwnedResponseKey(CANON.id)).toBe(true);
  });

  it("an unticked LEGACY record is reachable on a SUBMITTED intake", () => {
    // Before retirement this state was draft-only, because the submit gate
    // refused without an acceptance. Retirement removed that gate, so a
    // pre-retirement draft left unticked now submits and lands here. This is
    // the precondition for the copy assertion below.
    const unticked = {
      [CANON.id]: {
        id: CANON.id,
        version: CANON.version,
        wording: CANON.wording,
        accepted: false,
      },
    };
    for (const status of ["in_progress", "submitted", "reviewed"] as const) {
      const view = readElectrolysisAcknowledgement(unticked, status);
      expect(view.state, status).toBe("not_acknowledged");
      // The stored snapshot still renders truthfully in every case.
      expect(view.state === "not_acknowledged" && view.wording).toBe(
        CANON.wording,
      );
    }
  });

  it("no copy claims a missing acknowledgement still BLOCKS submission", () => {
    // Retirement removed the submit gate. Any copy saying an intake "cannot
    // be submitted" until the box is ticked is now false on a clinical
    // surface — exactly the defect the 'predates' rename fixed next door.
    for (const [key, value] of Object.entries(ACKNOWLEDGEMENT_REVIEW_COPY)) {
      expect(value, key).not.toMatch(/cannot be submitted/i);
      expect(value, key).not.toMatch(/until they do/i);
    }
    expect(ACKNOWLEDGEMENT_REVIEW_COPY.notAcknowledged).toBe(
      "Not acknowledged. The client did not tick this box.",
    );
  });

  it("no copy claims an intake 'predates' the acknowledgement", () => {
    // After retirement an intake submitted TODAY also carries no record, so
    // "predates" would be a falsehood on a clinical surface.
    for (const value of Object.values(ACKNOWLEDGEMENT_REVIEW_COPY)) {
      expect(value).not.toMatch(/predate/i);
    }
    expect(ACKNOWLEDGEMENT_REVIEW_COPY.notRecorded).toBe(
      "No versioned electrolysis acknowledgement was recorded with this intake.",
    );
  });
});
