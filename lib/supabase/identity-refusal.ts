/**
 * A CONTROLLED IDENTITY REFUSAL from `getCurrentPractitionerWithStudio`.
 *
 * WHY A TYPE AND NOT A MESSAGE (Codex, #860 4308620484 / 4308620487). These
 * two refusals happen BEFORE any write, so a caller holding a retry key must
 * report them as definitive rather than as an unknown outcome - otherwise it
 * freezes its controls and keeps a key whose every retry meets the same
 * refusal. Classifying that needs something a caller can test.
 *
 * NOT THE MESSAGE, because the same two sentences are also raised by the
 * DATABASE guard and listed in `lib/sessions/session-command-errors.ts`. A
 * text match would conflate a refusal from Postgres with one from this
 * process, and they differ on exactly the question that matters: whether a
 * write was attempted.
 *
 * THE MESSAGES ARE UNCHANGED, deliberately. They are Sentry issue titles and
 * several tests match them; this adds a type beside them rather than renaming
 * anything. `instanceof Error` stays true, so nothing that treats these as
 * ordinary errors changes behaviour.
 */
export type IdentityRefusalKind =
  | "no-active-practitioner"
  | "studio-choice-required";

export class IdentityRefusalError extends Error {
  readonly kind: IdentityRefusalKind;

  constructor(kind: IdentityRefusalKind, message: string) {
    super(message);
    this.name = "IdentityRefusalError";
    this.kind = kind;
  }
}
