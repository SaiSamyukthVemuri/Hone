import { describe, expect, it } from "vitest";
import {
  ACKNOWLEDGEMENT_REVIEW_COPY,
  buildElectrolysisAcknowledgementClaim,
  buildElectrolysisAcknowledgementDraftRecord,
  ELECTROLYSIS_ACKNOWLEDGEMENT,
  normalizeElectrolysisAcknowledgementClaim,
  readElectrolysisAcknowledgement,
  validateElectrolysisAcknowledgement,
} from "@/lib/intake/acknowledgements";
import { findMissingRequiredAnswers, INTAKE_STEPS } from "@/lib/intake/questions";

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
  out[CANON.id] = buildElectrolysisAcknowledgementClaim(true);
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

describe("2 + 14. unchecked default, and nothing auto-checks", () => {
  it("an empty responses map yields no acknowledgement and no acceptance", () => {
    const v = validateElectrolysisAcknowledgement({}, NOW);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("checkbox_missing");
  });

  it("the claim builder mirrors the checkbox rather than defaulting true", () => {
    expect(buildElectrolysisAcknowledgementClaim(false).accepted).toBe(false);
    expect(buildElectrolysisAcknowledgementClaim(true).accepted).toBe(true);
  });

  it("a draft record built from an unticked claim is not accepted", () => {
    const rec = buildElectrolysisAcknowledgementDraftRecord(
      buildElectrolysisAcknowledgementClaim(false),
    );
    expect(rec?.accepted).toBe(false);
  });
});

describe("3. client-side required enforcement rides the existing machinery", () => {
  it("registers the acknowledgement as a required checkbox on the last step", () => {
    const last = INTAKE_STEPS[INTAKE_STEPS.length - 1];
    const q = last.questions.find((x) => x.key === CANON.questionKey);
    expect(q).toBeDefined();
    expect(q?.type).toBe("checkbox");
    expect(q?.required).toBe(true);
    // Label and help text are the SHARED constants, not a second copy.
    expect(q?.label).toBe(CANON.wording);
    expect(q?.helpText).toBe(CANON.helpText);
  });

  it("is unconditional, so it can never be skipped by an earlier answer", () => {
    const q = INTAKE_STEPS.flatMap((s) => s.questions).find(
      (x) => x.key === CANON.questionKey,
    );
    expect(q?.conditional).toBeUndefined();
  });

  it("findMissingRequiredAnswers reports it missing when unticked", () => {
    expect(findMissingRequiredAnswers({})).toContain(CANON.questionKey);
    expect(
      findMissingRequiredAnswers({ [CANON.questionKey]: false }),
    ).toContain(CANON.questionKey);
    expect(
      findMissingRequiredAnswers(completeResponses()),
    ).not.toContain(CANON.questionKey);
  });
});

describe("4 + 5. draft serialization and restoration", () => {
  it("a draft record carries canonical id/version/wording and the client's boolean", () => {
    const rec = buildElectrolysisAcknowledgementDraftRecord(
      buildElectrolysisAcknowledgementClaim(true),
    );
    expect(rec).toEqual({
      id: CANON.id,
      version: CANON.version,
      wording: CANON.wording,
      accepted: true,
    });
    // A draft is not an acceptance: no timestamp is stamped until submit.
    expect(rec).not.toHaveProperty("accepted_at");
  });

  it("a draft record NEVER carries client-supplied wording, id or version", () => {
    const forged = normalizeElectrolysisAcknowledgementClaim({
      id: "something_else",
      version: "v99",
      wording: "I agree to whatever the studio wants.",
      accepted: true,
    });
    const rec = buildElectrolysisAcknowledgementDraftRecord(forged);
    expect(rec?.id).toBe(CANON.id);
    expect(rec?.version).toBe(CANON.version);
    expect(rec?.wording).toBe(CANON.wording);
  });

  it("round-trips: a saved draft record re-validates as accepted", () => {
    const saved = buildElectrolysisAcknowledgementDraftRecord(
      buildElectrolysisAcknowledgementClaim(true),
    );
    const restored = { [CANON.questionKey]: true, [CANON.id]: saved };
    const v = validateElectrolysisAcknowledgement(restored, NOW);
    expect(v.ok).toBe(true);
  });

  // NOTE ON SCOPE. "Unticking overwrites the stored record" is a property
  // of saveIntakeStepAction's merge, NOT of this pure module, and it is
  // proven against the real action in
  // tests/app/intake/electrolysis-acknowledgement-wiring.test.ts.
  //
  // An earlier version of this test tried to prove it here and was
  // vacuous twice over: it built `{ ...{ [id]: stale }, [id]: fresh }`,
  // where the later computed key wins at construction so the stale record
  // was discarded before the validator ever ran; and its lone
  // `expect(v.ok).toBe(false)` was satisfied by the checkbox branch, so it
  // could not distinguish the case it named. What this module can honestly
  // prove is the guarantee below — and it asserts the REASON, so it cannot
  // be satisfied by the wrong branch.
  it("a stale accepted record cannot rescue an unticked checkbox", () => {
    const stale = buildElectrolysisAcknowledgementDraftRecord(
      buildElectrolysisAcknowledgementClaim(true),
    );
    expect(stale?.accepted).toBe(true); // the stale record really is accepted
    const v = validateElectrolysisAcknowledgement(
      { [CANON.questionKey]: false, [CANON.id]: stale },
      NOW,
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("checkbox_missing");
  });

  it("an unticked record is rejected on its own reason, with the checkbox true", () => {
    // Reaches the record branch (the checkbox guard returns first
    // otherwise), so this pins the `not_accepted` path specifically.
    const v = validateElectrolysisAcknowledgement(
      {
        [CANON.questionKey]: true,
        [CANON.id]: buildElectrolysisAcknowledgementDraftRecord(
          buildElectrolysisAcknowledgementClaim(false),
        ),
      },
      NOW,
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("not_accepted");
  });
});

describe("6-10. the server gate — forged payloads are rejected, not corrected", () => {
  it("6. rejects a missing acknowledgement record", () => {
    const r = completeResponses();
    delete r[CANON.id];
    const v = validateElectrolysisAcknowledgement(r, NOW);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("missing");
  });

  it("7. rejects accepted: false", () => {
    const v = validateElectrolysisAcknowledgement(
      completeResponses({
        [CANON.id]: { ...buildElectrolysisAcknowledgementClaim(true), accepted: false },
      }),
      NOW,
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("not_accepted");
  });

  it("7b. rejects a truthy-but-not-true accepted value", () => {
    for (const sneaky of ["true", 1, "yes", {}, [], "on"]) {
      const v = validateElectrolysisAcknowledgement(
        completeResponses({
          [CANON.id]: {
            ...buildElectrolysisAcknowledgementClaim(true),
            accepted: sneaky,
          },
        }),
        NOW,
      );
      expect(v.ok, `accepted: ${JSON.stringify(sneaky)}`).toBe(false);
    }
  });

  it("8. rejects a wrong acknowledgement id", () => {
    const v = validateElectrolysisAcknowledgement(
      completeResponses({
        [CANON.id]: { ...buildElectrolysisAcknowledgementClaim(true), id: "marketing_consent" },
      }),
      NOW,
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("wrong_id");
  });

  it("9. rejects an unknown version — including a downgrade", () => {
    for (const version of ["v0", "v2", "", "V1", " v1"]) {
      const v = validateElectrolysisAcknowledgement(
        completeResponses({
          [CANON.id]: { ...buildElectrolysisAcknowledgementClaim(true), version },
        }),
        NOW,
      );
      expect(v.ok, `version ${JSON.stringify(version)}`).toBe(false);
      expect(v.ok === false && v.reason).toBe("unknown_version");
    }
  });

  it("9b. rejects altered wording, even a single trailing space", () => {
    for (const wording of [
      `${CANON.wording} `,
      CANON.wording.replace("permanent", "possibly permanent"),
      "I agree.",
      "",
    ]) {
      const v = validateElectrolysisAcknowledgement(
        completeResponses({
          [CANON.id]: { ...buildElectrolysisAcknowledgementClaim(true), wording },
        }),
        NOW,
      );
      expect(v.ok, `wording ${JSON.stringify(wording.slice(0, 24))}`).toBe(false);
      expect(v.ok === false && v.reason).toBe("wording_mismatch");
    }
  });

  it("9c. rejects a valid claim when the checkbox itself is not exactly true", () => {
    // Two independent keys must agree. A forger who writes only the record
    // still does not get an acknowledgement.
    for (const answer of [false, undefined, "true", 1]) {
      const v = validateElectrolysisAcknowledgement(
        completeResponses({ [CANON.questionKey]: answer }),
        NOW,
      );
      expect(v.ok, `checkbox ${JSON.stringify(answer)}`).toBe(false);
      expect(v.ok === false && v.reason).toBe("checkbox_missing");
    }
  });

  it("9d. rejects a malformed record (non-object, array, missing fields)", () => {
    for (const bad of [true, "yes", 42, [], null, {}, { accepted: true }]) {
      const v = validateElectrolysisAcknowledgement(
        completeResponses({ [CANON.id]: bad }),
        NOW,
      );
      expect(v.ok, `record ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("9e. rejects an oversize wording claim without retaining it", () => {
    const v = validateElectrolysisAcknowledgement(
      completeResponses({
        [CANON.id]: {
          ...buildElectrolysisAcknowledgementClaim(true),
          wording: "x".repeat(5000),
        },
      }),
      NOW,
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("missing");
  });

  it("10. accepts a valid acknowledgement and returns a server-authored record", () => {
    const v = validateElectrolysisAcknowledgement(completeResponses(), NOW);
    expect(v.ok).toBe(true);
    expect(v.ok === true && v.record).toEqual({
      id: CANON.id,
      version: CANON.version,
      wording: CANON.wording,
      accepted: true,
      accepted_at: NOW,
    });
  });

  it("10b. the stored record is rebuilt, so extra client fields never persist", () => {
    const v = validateElectrolysisAcknowledgement(
      completeResponses({
        [CANON.id]: {
          ...buildElectrolysisAcknowledgementClaim(true),
          accepted_at: "1999-01-01T00:00:00.000Z",
          signature_name: "Ada Lovelace",
          studio_id: "some-other-studio",
        },
      }),
      NOW,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.record.accepted_at).toBe(NOW);
    expect(v.record).not.toHaveProperty("signature_name");
    expect(v.record).not.toHaveProperty("studio_id");
    expect(Object.keys(v.record).sort()).toEqual([
      "accepted",
      "accepted_at",
      "id",
      "version",
      "wording",
    ]);
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
      expect(view.state).toBe("predates");
    }
    expect(ACKNOWLEDGEMENT_REVIEW_COPY.predates).toBe(
      "This intake predates the versioned electrolysis acknowledgement.",
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
    const view = readElectrolysisAcknowledgement(
      {
        [CANON.id]: buildElectrolysisAcknowledgementDraftRecord(
          buildElectrolysisAcknowledgementClaim(false),
        ),
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
