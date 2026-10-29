import "server-only";

import { IdentityRefusalError } from "@/lib/supabase/identity-refusal";
import {
  getCurrentPractitionerWithStudio,
  type PractitionerWithStudio,
} from "@/lib/supabase/queries";

/**
 * IDENTITY, RESOLVED FOR A WRITE THAT HOLDS A RETRY KEY.
 *
 * THE DEFECT THIS CLOSES (Codex, #860 4308620484 and 4308620487).
 * `getCurrentPractitionerWithStudio()` THROWS on two controlled refusals - a
 * membership that is no longer active, and two or more memberships with no
 * valid studio selection - and it throws BEFORE any RPC is reached, so nothing
 * has been written.
 *
 * But the callers that hold a retry key map EVERY throw to an unknown outcome:
 * `block-setup-form`'s create catch returns `unresolved` whenever settings are
 * attached, and `machine-reading-entry`'s catch returns `{ kind: "unknown" }`.
 * Unknown is the right answer for a lost response and the wrong one here. It
 * freezes the draft, the machine and mode pickers and Cancel, and KEEPS THE
 * RETRY KEY - and because the refusal happens before the write, every retry
 * meets the same refusal. The state can never settle, so she is left with a
 * form she can neither save nor dismiss.
 *
 * That deadlock is the cost of freezing each control correctly for a genuinely
 * unresolved save, with nothing distinguishing that from a refusal which
 * merely arrived the same way. Same shape as `SessionLineageError`
 * (4305702526 / 4304930968), and the same fix: say DEFINITIVELY that nothing
 * was written.
 *
 * ONE HELPER FOR BOTH SITES, so they cannot drift. The previous pair of fixes
 * was written twice, once per site, and the second one had to be found
 * separately - "a shared helper that callers may ignore is not one definition,
 * it is a fourth one waiting to be written".
 *
 * CLASSIFIED BY TYPE, NEVER BY MESSAGE. Those two sentences also appear in
 * `lib/sessions/session-command-errors.ts`, where they are raised by the
 * DATABASE guard - so matching on the text would conflate a refusal from
 * Postgres with one from this process, and the two have different meanings for
 * whether a write was attempted.
 *
 * AND EVERYTHING ELSE IS RE-THROWN UNCHANGED, which is what keeps Next's
 * `redirect()` and `notFound()` signals working: `getCurrentPractitionerWithStudio`
 * redirects an anonymous caller to /login by throwing a routing signal, and
 * swallowing that would turn a sign-in into a silent refusal. Because exactly
 * one error TYPE is converted here, every signal and every genuine fault
 * propagates by construction rather than by a list of exceptions that has to
 * be kept up to date.
 */
export type WritingIdentity =
  | { ok: true; value: PractitionerWithStudio }
  /**
   * DEFINITIVE. Nothing was written and a retry cannot change that, so the
   * caller must release the retry key and unfreeze its controls.
   *
   * `unauthenticated` is definitive in the same way and kept SEPARATE because
   * the callers already distinguish it and their tests drive it. A regression
   * is what put it here: replacing the local `identity()` wrapper dropped its
   * `if (!who) return null` branch, and the action crashed on
   * `who.value.studio` instead of refusing. The wrapper's contract allowed a
   * falsy identity even though production redirects or throws first, so the
   * branch is preserved rather than argued away.
   */
  | { ok: false; code: "rejected" | "unauthenticated"; error: string };

/**
 * Said to the practitioner, and the important half of each sentence is
 * "Nothing was saved" — the whole defect was a screen that implied the
 * opposite and offered a retry that could not succeed.
 *
 * WORDING IS A PRODUCT ITEM. These are in Sam's packet; they are written to be
 * plain and actionable rather than final, and neither invents a clinical
 * instruction.
 */
export const IDENTITY_REFUSED_NO_MEMBERSHIP =
  "Your access to this studio has changed, so nothing was saved. Sign in " +
  "again, or ask the studio owner to restore your access.";

export const IDENTITY_REFUSED_CHOOSE_STUDIO =
  "Choose which studio you are working in before saving. Nothing was saved.";

/** Byte-identical to what the local `identity()` wrapper's callers showed. */
export const IDENTITY_NOT_SIGNED_IN = "Sign in first.";

export async function resolveWritingIdentity(): Promise<WritingIdentity> {
  try {
    const value = await getCurrentPractitionerWithStudio();
    // FALSY IS REFUSED, NOT DEREFERENCED. See the note on `unauthenticated`.
    if (!value) {
      return {
        ok: false,
        code: "unauthenticated",
        error: IDENTITY_NOT_SIGNED_IN,
      };
    }
    return { ok: true, value };
  } catch (cause) {
    if (cause instanceof IdentityRefusalError) {
      return {
        ok: false,
        code: "rejected",
        error:
          cause.kind === "studio-choice-required"
            ? IDENTITY_REFUSED_CHOOSE_STUDIO
            : IDENTITY_REFUSED_NO_MEMBERSHIP,
      };
    }
    // A ROUTING SIGNAL OR A REAL FAULT. Both must reach the framework
    // unchanged: a redirect is how an anonymous caller gets to /login, and a
    // genuine fault is an unknown outcome that the caller is RIGHT to hold.
    throw cause;
  }
}
