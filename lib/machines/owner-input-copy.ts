/**
 * What an owner is told to do when their machine's model is not listed.
 *
 * ONE string, so every owner-facing surface says the same thing. The charting
 * panel's owner hint (#1272) renders the same text, written out in its JSX;
 * tests/components/machine-register-form.test.ts pins the two together once
 * both are on the branch. Never a promise: it states what is true today,
 * asks for no client details, and says sending the details only starts a
 * review.
 */
export const OWNER_INPUT_REQUEST =
  "Today only models that have passed their evidence review can be registered. " +
  "If yours is not listed, send Hone the manufacturer, the exact model and variant, " +
  "the label on your unit, its modes, and the field names and units the machine shows, " +
  "with the manual page or a photo of the screen with no client on screen. " +
  "Never include client details. Sending this starts a review; it does not add the model.";
