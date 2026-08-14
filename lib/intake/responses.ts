// Shared sanitization for `client_intake_forms.responses`.
//
// Two callers, two different admitted sets, ONE whitelist implementation:
//
//   sanitizeQuestionResponses         , the public, token-authenticated
//                                        client wizard. Admits every
//                                        questionnaire key.
//   sanitizePractitionerAssistedAnswers, the authenticated practitioner
//                                        assisted editor. Admits the same set
//                                        MINUS every key the client alone may
//                                        author.
//
// Both are key whitelists that copy the value through untouched. That is the
// pre-existing contract (the public sanitizer has always been a key filter,
// not a value validator) and this module does not change it; required-ness and
// per-type validation live in lib/intake/questions.ts and run separately.
//
// WHAT MUST NEVER BE ADDED HERE
// -----------------------------
// The practitioner-assisted provenance key
// (lib/intake/entry-provenance.ts) must NEVER be admitted by either function.
// It is not a questionnaire answer and it is not a client claim: it is derived
// on the server from the authenticated session. Admitting it, even "narrowed"
// the way the electrolysis acknowledgement claim is admitted by the public
// action: would let whoever holds the intake token author, replace or erase
// practitioner attribution. tests/source-guards/assisted-intake-guards.test.ts
// pins that this file never references the provenance key.

import {
  ALL_QUESTION_KEYS,
  isClientOwnedResponseKey,
} from "@/lib/intake/questions";

function whitelist(
  input: unknown,
  admit: (key: string) => boolean,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (admit(key)) out[key] = value;
  }
  return out;
}

// Every known question key (and its `_notes` sibling). This is the exact
// behaviour the public intake actions have always had; it was module-private
// there and is now shared so the assisted path derives from the same set
// rather than maintaining a second copy.
export function sanitizeQuestionResponses(
  input: unknown,
): Record<string, unknown> {
  const allowed = new Set(ALL_QUESTION_KEYS);
  return whitelist(input, (key) => allowed.has(key));
}

// The practitioner-enterable subset: known question keys that are NOT
// client-owned.
//
// A practitioner may record what the client tells them about their health
// history. A practitioner may not tick the client's first-person
// acknowledgements, and may not author the versioned electrolysis
// acknowledgement record. Those are the client's own statements. Anything in
// CLIENT_OWNED_RESPONSE_KEYS is dropped silently here rather than rejected,
// because a legitimate assisted save carrying a stale merged map should still
// save the answers it is allowed to save; the caller separately reports when a
// forbidden key would be CHANGED (see assistedKeysChanged).
export function sanitizePractitionerAssistedAnswers(
  input: unknown,
): Record<string, unknown> {
  const allowed = new Set(ALL_QUESTION_KEYS);
  return whitelist(
    input,
    (key) => allowed.has(key) && !isClientOwnedResponseKey(key),
  );
}

// The client-owned keys an inbound practitioner payload would CHANGE.
//
// Refusing on mere key PRESENCE was wrong and shipped a hard-block: the
// assisted editor seeds its state from the stored responses and posts the whole
// map, so an intake where the client had already touched a step-5 checkbox
// through their own link (ticking OR unticking: presence, not value) made
// every assisted save fail, with copy blaming the practitioner and naming a
// button that could never mount. It also contradicted this module's own
// contract below, which says a stale merged map should still save what it may.
//
// Comparing against what is STORED keeps the boundary exactly as strong: the
// practitioner still cannot set, alter or clear a client-owned answer, while
// letting a payload that merely echoes the client's own value through.
// Sanitization drops these keys regardless; this is the loud backstop.
export function assistedKeysChanged(
  input: unknown,
  stored: Record<string, unknown>,
): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const incoming = input as Record<string, unknown>;
  return Object.keys(incoming).filter((key) => {
    if (!isClientOwnedResponseKey(key)) return false;
    return !sameJsonValue(incoming[key], stored[key]);
  });
}

// Structural equality over the JSON shapes an intake answer can hold
// (primitives, arrays of primitives, and the acknowledgement record object).
function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
