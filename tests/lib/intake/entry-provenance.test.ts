import { describe, expect, it } from "vitest";
import {
  ALL_QUESTION_KEYS,
  CLIENT_OWNED_RESPONSE_KEYS,
  INTAKE_STEPS,
  isClientOwnedResponseKey,
} from "@/lib/intake/questions";
import { ELECTROLYSIS_ACKNOWLEDGEMENT } from "@/lib/intake/acknowledgements";
import {
  ASSISTED_ENTRY_REVIEW_COPY,
  PRACTITIONER_ASSISTED_ENTRY,
  readAssistedEntry,
  recordAssistedEntry,
  recordAssistedHandoff,
} from "@/lib/intake/entry-provenance";
import {
  assistedKeysChanged,
  sanitizePractitionerAssistedAnswers,
  sanitizeQuestionResponses,
} from "@/lib/intake/responses";

const KEY = PRACTITIONER_ASSISTED_ENTRY.id;
const A = { practitioner_id: "prac-a", display_name: "Chloe Baca" };
const B = { practitioner_id: "prac-b", display_name: "Jane Doe" };
const T1 = "2026-08-07T10:00:00.000Z";
const T2 = "2026-08-07T11:30:00.000Z";
const T3 = "2026-08-07T12:00:00.000Z";

// ---------------------------------------------------------------------------
describe("the reserved key can never become a questionnaire answer", () => {
  it("is not in ALL_QUESTION_KEYS", () => {
    expect(ALL_QUESTION_KEYS).not.toContain(KEY);
  });

  it("is not any question key or _notes sibling", () => {
    for (const step of INTAKE_STEPS) {
      for (const q of step.questions) {
        expect(q.key).not.toBe(KEY);
        expect(`${q.key}_notes`).not.toBe(KEY);
      }
    }
  });

  it("does not collide with the electrolysis acknowledgement's two keys", () => {
    expect(KEY).not.toBe(ELECTROLYSIS_ACKNOWLEDGEMENT.id);
    expect(KEY).not.toBe(ELECTROLYSIS_ACKNOWLEDGEMENT.questionKey);
  });

  it("is dropped by the PUBLIC sanitizer, the client cannot author it", () => {
    const forged = {
      legal_name: "Dana",
      [KEY]: {
        mode: "practitioner_assisted",
        version: "v1",
        started_at: T1,
        started_by: A,
        last_updated_at: T1,
        last_updated_by: A,
      },
    };
    const out = sanitizeQuestionResponses(forged);
    expect(out).not.toHaveProperty(KEY);
    expect(out.legal_name).toBe("Dana");
  });

  it("is dropped by the ASSISTED sanitizer too, it is never client input", () => {
    const out = sanitizePractitionerAssistedAnswers({
      legal_name: "Dana",
      [KEY]: { mode: "practitioner_assisted" },
    });
    expect(out).not.toHaveProperty(KEY);
  });
});

// ---------------------------------------------------------------------------
describe("the client-owned key set is derived, not listed", () => {
  it("covers every question on the acknowledgements step", () => {
    const last = INTAKE_STEPS[INTAKE_STEPS.length - 1];
    for (const q of last.questions) {
      expect(isClientOwnedResponseKey(q.key)).toBe(true);
      expect(isClientOwnedResponseKey(`${q.key}_notes`)).toBe(true);
    }
  });

  it("covers every checkbox question ANYWHERE in the form", () => {
    for (const step of INTAKE_STEPS) {
      for (const q of step.questions) {
        if (q.type === "checkbox") {
          expect(isClientOwnedResponseKey(q.key)).toBe(true);
        }
      }
    }
  });

  it("includes the #518 acknowledgement checkbox", () => {
    expect(
      isClientOwnedResponseKey(ELECTROLYSIS_ACKNOWLEDGEMENT.questionKey),
    ).toBe(true);
  });

  it("does NOT claim ordinary questionnaire answers", () => {
    for (const key of ["legal_name", "pronouns", "medical_conditions", "email"]) {
      expect(isClientOwnedResponseKey(key)).toBe(false);
    }
  });

  it("the assisted sanitizer admits questionnaire keys and drops client-owned ones", () => {
    const input: Record<string, unknown> = { legal_name: "Dana" };
    for (const k of CLIENT_OWNED_RESPONSE_KEYS) input[k] = true;
    const out = sanitizePractitionerAssistedAnswers(input);
    expect(out.legal_name).toBe("Dana");
    for (const k of CLIENT_OWNED_RESPONSE_KEYS) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it("assistedKeysChanged names only the client-owned keys a payload would CHANGE", () => {
    // Nothing client-owned at all.
    expect(assistedKeysChanged({ legal_name: "Dana" }, {})).toEqual([]);
    // Setting one that is absent -> a change.
    expect(
      assistedKeysChanged({ legal_name: "Dana", ack_accurate: true }, {}),
    ).toEqual(["ack_accurate"]);
    // Echoing back exactly what the CLIENT already stored -> NOT a change.
    // This is the case that used to hard-block every assisted save.
    expect(
      assistedKeysChanged({ ack_accurate: true }, { ack_accurate: true }),
    ).toEqual([]);
    expect(
      assistedKeysChanged({ ack_accurate: false }, { ack_accurate: false }),
    ).toEqual([]);
    // Flipping the client's answer IS a change, in either direction.
    expect(
      assistedKeysChanged({ ack_accurate: false }, { ack_accurate: true }),
    ).toEqual(["ack_accurate"]);
    expect(
      assistedKeysChanged({ ack_accurate: true }, { ack_accurate: false }),
    ).toEqual(["ack_accurate"]);
    // Clearing it is a change too.
    expect(
      assistedKeysChanged({ ack_accurate: undefined }, { ack_accurate: true }),
    ).toEqual(["ack_accurate"]);
    // Structural comparison, not reference identity.
    expect(
      assistedKeysChanged(
        { [ELECTROLYSIS_ACKNOWLEDGEMENT.id]: { a: 1, b: [2] } },
        { [ELECTROLYSIS_ACKNOWLEDGEMENT.id]: { a: 1, b: [2] } },
      ),
    ).toEqual([]);
    expect(
      assistedKeysChanged(
        { [ELECTROLYSIS_ACKNOWLEDGEMENT.id]: { a: 1 } },
        { [ELECTROLYSIS_ACKNOWLEDGEMENT.id]: { a: 2 } },
      ),
    ).toEqual([ELECTROLYSIS_ACKNOWLEDGEMENT.id]);
  });

  // The future-proofing rule, stated as an executable expectation rather than
  // a comment: a checkbox added to ANY step is practitioner-forbidden the
  // moment it exists, with no list to remember to update.
  it("a hypothetical new checkbox on any step would be client-owned", () => {
    const everyCheckbox = INTAKE_STEPS.flatMap((s) =>
      s.questions.filter((q) => q.type === "checkbox").map((q) => q.key),
    );
    expect(everyCheckbox.length).toBeGreaterThan(0);
    for (const k of everyCheckbox) {
      expect(CLIENT_OWNED_RESPONSE_KEYS.has(k)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe("recordAssistedEntry", () => {
  it("creates a record naming the actor and the server clock", () => {
    const rec = recordAssistedEntry(undefined, A, T1);
    expect(rec).toEqual({
      mode: "practitioner_assisted",
      version: "v1",
      started_at: T1,
      started_by: A,
      last_updated_at: T1,
      last_updated_by: A,
    });
  });

  it("preserves who STARTED when a second practitioner continues", () => {
    const first = recordAssistedEntry(undefined, A, T1);
    const second = recordAssistedEntry(first, B, T2);
    expect(second.started_at).toBe(T1);
    expect(second.started_by).toEqual(A);
    expect(second.last_updated_at).toBe(T2);
    expect(second.last_updated_by).toEqual(B);
  });

  it("cannot be told who started by the value it is given", () => {
    // A forged existing value whose started_by is well-formed IS honoured,
    // that is the point of preserving it, but it can only ever come from the
    // stored row, never from request input (proved in the action tests). What
    // must NOT happen is a malformed claim silently becoming attribution.
    const malformed = { mode: "practitioner_assisted", started_by: "prac-evil" };
    const rec = recordAssistedEntry(malformed, A, T1);
    expect(rec.started_by).toEqual(A);
    expect(rec.started_at).toBe(T1);
  });

  it("preserves an existing handoff stamp", () => {
    const started = recordAssistedEntry(undefined, A, T1);
    const handed = recordAssistedHandoff(started, A, T2)!;
    const later = recordAssistedEntry(handed, B, T3);
    expect(later.handoff_at).toBe(T2);
    expect(later.handoff_by).toEqual(A);
  });

  it("rejects an actor with blank or oversize fields", () => {
    const rec = recordAssistedEntry(
      {
        mode: "practitioner_assisted",
        version: "v1",
        started_at: T1,
        started_by: { practitioner_id: "prac-x", display_name: "   " },
        last_updated_at: T1,
        last_updated_by: { practitioner_id: "prac-x", display_name: "ok" },
      },
      A,
      T2,
    );
    // started_by was unreadable, so the whole stored record was unusable and
    // this write re-establishes a truthful one.
    expect(rec.started_by).toEqual(A);
  });
});

// ---------------------------------------------------------------------------
describe("recordAssistedHandoff", () => {
  it("stamps handoff without moving last_updated", () => {
    const started = recordAssistedEntry(undefined, A, T1);
    const handed = recordAssistedHandoff(started, B, T2)!;
    expect(handed.handoff_at).toBe(T2);
    expect(handed.handoff_by).toEqual(B);
    expect(handed.last_updated_at).toBe(T1);
    expect(handed.last_updated_by).toEqual(A);
    expect(handed.started_by).toEqual(A);
  });

  it("returns null when no assisted entry happened", () => {
    expect(recordAssistedHandoff(undefined, A, T1)).toBeNull();
    expect(recordAssistedHandoff({}, A, T1)).toBeNull();
    expect(recordAssistedHandoff({ mode: "something_else" }, A, T1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("readAssistedEntry", () => {
  it("an ordinary self-completed intake reads as 'none'", () => {
    expect(readAssistedEntry({}).state).toBe("none");
    expect(readAssistedEntry({ legal_name: "Dana" }).state).toBe("none");
    expect(readAssistedEntry(null).state).toBe("none");
    expect(readAssistedEntry(undefined).state).toBe("none");
  });

  it("a legacy intake predating this feature reads as 'none'", () => {
    const legacy = {
      legal_name: "Dana",
      [ELECTROLYSIS_ACKNOWLEDGEMENT.id]: {
        id: ELECTROLYSIS_ACKNOWLEDGEMENT.id,
        version: "v1",
        wording: ELECTROLYSIS_ACKNOWLEDGEMENT.wording,
        accepted: true,
      },
    };
    expect(readAssistedEntry(legacy).state).toBe("none");
  });

  it("reads a well-formed record", () => {
    const rec = recordAssistedEntry(undefined, A, T1);
    const view = readAssistedEntry({ [KEY]: rec });
    expect(view.state).toBe("assisted");
    if (view.state !== "assisted") return;
    expect(view.startedBy).toEqual(A);
    expect(view.lastUpdatedBy).toEqual(A);
    expect(view.showLastUpdated).toBe(false);
    expect(view.handoffAtIso).toBeNull();
  });

  it("flags two distinct actors", () => {
    const rec = recordAssistedEntry(recordAssistedEntry(undefined, A, T1), B, T2);
    const view = readAssistedEntry({ [KEY]: rec });
    if (view.state !== "assisted") throw new Error("expected assisted");
    expect(view.showLastUpdated).toBe(true);
    expect(view.startedBy.display_name).toBe("Chloe Baca");
    expect(view.lastUpdatedBy.display_name).toBe("Jane Doe");
  });

  it("a malformed record reads as 'unreadable', never as assisted", () => {
    for (const bad of [
      { mode: "practitioner_assisted" },
      { mode: "practitioner_assisted", started_by: A },
      "a string",
      42,
      [],
    ]) {
      expect(readAssistedEntry({ [KEY]: bad }).state).toBe("unreadable");
    }
  });

  it("half a handoff is dropped rather than half-rendered", () => {
    const rec = {
      ...recordAssistedEntry(undefined, A, T1),
      handoff_at: T2,
      // no handoff_by
    };
    const view = readAssistedEntry({ [KEY]: rec });
    if (view.state !== "assisted") throw new Error("expected assisted");
    expect(view.handoffAtIso).toBeNull();
    expect(view.handoffBy).toBeNull();
  });

  it("never throws on hostile input", () => {
    const hostile: unknown[] = [
      { [KEY]: { started_by: { practitioner_id: "x".repeat(10_000) } } },
      { [KEY]: null },
      { [KEY]: { mode: "practitioner_assisted", started_by: [] } },
    ];
    for (const h of hostile) {
      expect(() =>
        readAssistedEntry(h as Record<string, unknown>),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
describe("review copy stays truthful", () => {
  const strings = Object.values(ASSISTED_ENTRY_REVIEW_COPY);
  const all = strings.join(" ");

  // The property this module exists to protect: no copy may ASSERT a physical
  // act by the client, or that the client authored anything. The record proves
  // only that an authenticated practitioner did something, and when.
  //
  // The previous version of this test grepped three phrases
  // (/verified identity|proves|confirmed identity/i) that none of the
  // constants would ever plausibly contain, it was named for the PR's most
  // load-bearing truthfulness property and asserted nothing about it. Adversarial
  // review caught that. This one is written as a predicate plus a TWO-WAY
  // self-test, so the guard is proven to bite before it is trusted.
  const OVERCLAIM_PATTERNS: ReadonlyArray<RegExp> = [
    // The client performing an act, asserted rather than recorded.
    /\bclient\b[^.]*\b(ticked|signed|typed|entered|accepted|agreed|completed|submitted)\b/i,
    // The client receiving something, asserted as observed fact.
    /\bclient\b[^.]*\bwas\s+(then\s+)?(handed|given|shown|sent)\b/i,
    /\bhanded\s+(the\s+)?(intake|device|form)\s+to\b/i,
    // Identity / device claims.
    /\b(verified|confirmed|proves?|proven)\b[^.]*\b(identity|client|person)\b/i,
    /\bpersonally\b/i,
    /\bon (their|his|her) own device\b/i,
    // Anything that dresses this up as consent or a signature.
    /\bsign(ed|ature)?\b/i,
    /\bconsent\b/i,
  ];

  function overclaims(text: string): RegExp[] {
    return OVERCLAIM_PATTERNS.filter((re) => re.test(text));
  }

  it("SELF-TEST: the predicate rejects real overclaiming copy", () => {
    // If these do not trip it, the assertions below prove nothing.
    const BAD = [
      "The client personally ticked these acknowledgements.",
      "The client was then handed the intake to complete their own acknowledgements.",
      "The client signed this intake.",
      "The client accepted the terms on their own device.",
      "Hone verified the identity of the client.",
      "The client typed these answers themselves.",
      "This records the client's consent.",
      "We handed the intake to the client.",
    ];
    for (const bad of BAD) {
      expect(overclaims(bad), `predicate missed: ${bad}`).not.toHaveLength(0);
    }
  });

  it("SELF-TEST: the predicate accepts truthfully hedged copy", () => {
    // ...and it must not be so broad that every honest sentence trips it,
    // which would make the real assertion below vacuous in the other direction.
    const GOOD = [
      "A handover to the client was recorded by",
      "No handover to the client has been recorded for this intake yet.",
      "Questionnaire answers were recorded with the client by",
      "The acknowledgements themselves are recorded separately below.",
    ];
    for (const good of GOOD) {
      expect(overclaims(good), `predicate over-triggered on: ${good}`).toHaveLength(0);
    }
  });

  it("no shipped copy string overclaims", () => {
    expect(strings.length).toBeGreaterThanOrEqual(6);
    for (const text of strings) {
      expect(overclaims(text), `overclaiming copy: ${text}`).toHaveLength(0);
    }
  });

  it("the positive and negative handover branches are BOTH hedged", () => {
    // The asymmetry that adversarial review found: the negative branch said
    // "has been recorded" while the positive branch asserted the physical act.
    for (const text of [
      ASSISTED_ENTRY_REVIEW_COPY.handedOver,
      ASSISTED_ENTRY_REVIEW_COPY.notHandedOver,
    ]) {
      expect(text).toMatch(/recorded/i);
    }
  });

  it("never uses the review page's forbidden clinical vocabulary", () => {
    // Mirrors tests/app/clients/intake-review-flags.test.ts, which greps the
    // rendered review page.
    expect(all).not.toMatch(/\bsafe\b|\bunsafe\b|\bcleared\b|\bapproved\b/i);
    expect(all).not.toMatch(/contraindicat|diagnos|clinically verified/i);
  });
});

// ---------------------------------------------------------------------------
describe("regressions found by adversarial review", () => {
  it("a display_name longer than the parser accepts is bounded on WRITE", () => {
    // Previously the write stored the actor verbatim while the read rejected
    // any field over the cap, so an oversize name produced a record this
    // module's own parser refused, attribution vanished as "unreadable".
    const long = { practitioner_id: "prac-a", display_name: "N".repeat(5000) };
    const rec = recordAssistedEntry(undefined, long, T1);
    const view = readAssistedEntry({ [KEY]: rec });
    expect(view.state).toBe("assisted");
    if (view.state !== "assisted") return;
    expect(view.startedBy.display_name.length).toBeLessThanOrEqual(400);
  });

  it("a later edit by the SAME practitioner is still shown", () => {
    // showLastUpdated compared actor identity only, so an edit made after the
    // handover was concealed and the card implied recording finished first.
    const started = recordAssistedEntry(undefined, A, T1);
    const handed = recordAssistedHandoff(started, A, T2)!;
    const editedAfterHandoff = recordAssistedEntry(handed, A, T3);
    const view = readAssistedEntry({ [KEY]: editedAfterHandoff });
    if (view.state !== "assisted") throw new Error("expected assisted");
    expect(view.showLastUpdated).toBe(true);
    expect(view.lastUpdatedAtIso).toBe(T3);
    expect(view.handoffAtIso).toBe(T2);
  });

  it("one practitioner, one instant: the extra line is suppressed", () => {
    const rec = recordAssistedEntry(undefined, A, T1);
    const view = readAssistedEntry({ [KEY]: rec });
    if (view.state !== "assisted") throw new Error("expected assisted");
    expect(view.showLastUpdated).toBe(false);
  });

  it("handoff_by is carried into the view so it can be rendered", () => {
    // It was stored and projected but never displayed, the one actor fact the
    // record genuinely holds was the one omitted.
    const started = recordAssistedEntry(undefined, A, T1);
    const handed = recordAssistedHandoff(started, B, T2)!;
    const view = readAssistedEntry({ [KEY]: handed });
    if (view.state !== "assisted") throw new Error("expected assisted");
    expect(view.handoffBy).toEqual(B);
  });
});
