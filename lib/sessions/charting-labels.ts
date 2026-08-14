// Shared, single-source terminology for the charting forms and the saved-record
// display, so the two chip groups read identically everywhere and are never
// confused with each other (Chloe charting-usability polish). This is a
// display-only vocabulary: it changes NO stored field:
//   * Treatment observations  -> observation_chips (MULTI-select, what was seen)
//   * Client / skin response  -> reaction_type     (SINGLE-select, how it reacted)
// Keeping the strings in one module lets BlockSetupForm, SimplifiedEntryForm and
// session-blocks-view stay consistent (and lets tests assert that consistency).

export const TREATMENT_OBSERVATIONS_HEADING = "Treatment observations";
export const TREATMENT_OBSERVATIONS_HELPER =
  "What you saw during treatment: follicle, skin, and hair. Tap all that apply.";

export const CLIENT_RESPONSE_HEADING = "Client / skin response";
export const CLIENT_RESPONSE_HELPER =
  "How the client's skin reacted during or right after treatment. Choose one.";

// Charting UNIFICATION (Chloe): the two groups above are merged into ONE
// multi-select box. observation_chips is the canonical multi-select store; a
// legacy reaction_type is folded into it. This is the heading/helper for that box.
export const OBSERVATIONS_RESPONSE_HEADING =
  "Treatment observations & skin response";
export const OBSERVATIONS_RESPONSE_HELPER =
  "What you saw and how the skin responded: follicle, skin, hair, and reaction. Tap all that apply.";

export const ADDITIONAL_NOTES_HEADING = "Additional notes";
export const ADDITIONAL_NOTES_HELPER =
  "Anything the observations above don't cover. Multiple lines are fine.";
