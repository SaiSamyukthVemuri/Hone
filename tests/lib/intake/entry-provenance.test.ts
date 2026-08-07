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
  assistedKeysRejected,
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

  it("is dropped by the PUBLIC sanitizer — the client cannot author it", () => {
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

  it("is dropped by the ASSISTED sanitizer too — it is never client input", () => {
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

  it("assistedKeysRejected names exactly the client-owned keys present", () => {
    expect(assistedKeysRejected({ legal_name: "Dana" })).toEqual([]);
    expect(
      assistedKeysRejected({ legal_name: "Dana", ack_accurate: true }),
    ).toEqual(["ack_accurate"]);
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
    // A forged existing value whose started_by is well-formed IS honoured —
    // that is the point of preserving it — but it can only ever come from the
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
    expect(view.singleActor).toBe(true);
    expect(view.handoffAtIso).toBeNull();
  });

  it("flags two distinct actors", () => {
    const rec = recordAssistedEntry(recordAssistedEntry(undefined, A, T1), B, T2);
    const view = readAssistedEntry({ [KEY]: rec });
    if (view.state !== "assisted") throw new Error("expected assisted");
    expect(view.singleActor).toBe(false);
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
  const all = Object.values(ASSISTED_ENTRY_REVIEW_COPY).join(" ");

  it("never claims a signature, consent or acceptance by the practitioner", () => {
    expect(all).not.toMatch(/\bsigned\b|\bsignature\b|\bconsent\b/i);
    expect(all).not.toMatch(/on behalf of|as the client|for the client\b/i);
  });

  it("never uses the review page's forbidden clinical vocabulary", () => {
    // Mirrors tests/app/clients/intake-review-flags.test.ts, which greps the
    // rendered review page. Keeping the constants clean keeps that green.
    expect(all).not.toMatch(/\bsafe\b|\bunsafe\b|\bcleared\b|\bapproved\b/i);
    expect(all).not.toMatch(/contraindicat|diagnos|clinically verified/i);
  });

  it("does not claim the client personally operated the device", () => {
    expect(all).not.toMatch(/verified identity|proves|confirmed identity/i);
  });
});
