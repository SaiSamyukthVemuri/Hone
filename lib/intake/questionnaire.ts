// Approved issue-time catalogue. Never replace this document when questions change:
// append a reviewed supported version and its DB literal instead.
import issued from "./questionnaire-v1.json";
import { INTAKE_STEPS, CLIENT_OWNED_RESPONSE_KEYS, NONE_VALUE, type Step } from "./questions";

export const QUESTIONNAIRE_UNAVAILABLE = "This intake's questionnaire could not be verified. Your changes have not been submitted. Please contact the studio.";
export const QUESTIONNAIRE_HISTORY_UNAVAILABLE = "The original questionnaire could not be verified. Labelled answers are unavailable.";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const ISSUED_QUESTIONNAIRE = freeze(issued);

// Match only a shipped, approved complete document. Bounded iterative traversal:
// no arbitrary schema interpretation, recursive caller rules, or hash-only trust.
function approved(value: unknown): boolean {
  const pending: Array<[unknown, unknown, number]> = [[value, ISSUED_QUESTIONNAIRE, 0]];
  let visited = 0;
  while (pending.length) {
    if (++visited > 10000) return false;
    const [actual, expected, depth] = pending.pop()!;
    if (depth > 12) return false;
    if (expected === null || typeof expected !== "object") {
      if (actual !== expected) return false;
      continue;
    }
    if (!actual || typeof actual !== "object" || Array.isArray(actual) !== Array.isArray(expected)) return false;
    const keys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    if (keys.length !== actualKeys.length || actualKeys.some((key) => !Object.hasOwn(expected, key))) return false;
    for (const key of keys) pending.push([
      (actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], depth + 1,
    ]);
  }
  return true;
}
export type Questionnaire = {
  kind: "legacy" | "known" | "invalid";
  steps: ReadonlyArray<Step>;
  clientOwnedKeys: ReadonlySet<string>;
  noneValue: string;
};
export function questionnaireForRow(value: unknown): Questionnaire {
  if (value === null) return { kind: "legacy", steps: INTAKE_STEPS, clientOwnedKeys: CLIENT_OWNED_RESPONSE_KEYS, noneValue: NONE_VALUE };
  if (!approved(value)) return { kind: "invalid", steps: [], clientOwnedKeys: new Set(), noneValue: NONE_VALUE };
  // Use the validated shipped document, never an untrusted object reference.
  return { kind: "known", steps: ISSUED_QUESTIONNAIRE.catalogue.steps as ReadonlyArray<Step>,
    clientOwnedKeys: new Set([...ISSUED_QUESTIONNAIRE.catalogue.client_owned_keys, ...CLIENT_OWNED_RESPONSE_KEYS]), noneValue: ISSUED_QUESTIONNAIRE.catalogue.none_value };
}
