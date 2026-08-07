// Shared sanitization for `client_intake_forms.responses`.
//
// Two callers, two different admitted sets, ONE whitelist implementation:
//
//   sanitizeQuestionResponses          — the public, token-authenticated
//                                        client wizard. Admits every
//                                        questionnaire key.
//   sanitizePractitionerAssistedAnswers — the authenticated practitioner
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
// on the server from the authenticated session. Admitting it — even "narrowed"
// the way the electrolysis acknowledgement claim is admitted by the public
// action — would let whoever holds the intake token author, replace or erase
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
// acknowledgement record — those are the client's own statements. Anything in
// CLIENT_OWNED_RESPONSE_KEYS is dropped silently here rather than rejected,
// because a legitimate assisted save carrying a stale merged map should still
// save the answers it is allowed to save; the caller separately reports when a
// forbidden key was present (see assistedKeysRejected).
export function sanitizePractitionerAssistedAnswers(
  input: unknown,
): Record<string, unknown> {
  const allowed = new Set(ALL_QUESTION_KEYS);
  return whitelist(
    input,
    (key) => allowed.has(key) && !isClientOwnedResponseKey(key),
  );
}

// The client-owned keys present in an inbound practitioner payload. Used to
// fail the request loudly rather than only stripping, so a UI bug or a crafted
// request surfaces instead of silently half-succeeding.
export function assistedKeysRejected(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.keys(input as Record<string, unknown>).filter((key) =>
    isClientOwnedResponseKey(key),
  );
}
