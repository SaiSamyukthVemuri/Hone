// ===========================================================================
// THE INVITATION WINDOW — HOW LONG A RECIPIENT HAS TO BOOK
// ===========================================================================
//
// PURE, AND DELIBERATELY TINY. No import, no I/O, no server-only. Four values
// and nothing else, so that every surface which needs to know the window can
// import it without dragging anything along.
//
// WHY THIS IS ITS OWN MODULE, AND NOT A SECTION OF b4-invitation-draft.ts.
// The composer's model is a PROTOTYPE: its header says "PURE, AND NOT REACHED
// BY THE APPLICATION", and `tests/lib/waitlist/b4-invitation-draft.test.ts`
// walks the import graph to prove exactly two sanctioned entry points reach it.
//
// The window is not prototype material. It is needed by:
//
//   * the composer model            (which offers the choice)
//   * invite-to-book-adapter.ts     (which re-checks the submission)
//   * lib/booking/waitlist-invitation.ts  (whose issue path needs a fallback)
//   * components/waitlist/invite-composer.tsx (whose number input advertises
//                                              the bound to a practitioner)
//
// and the last two are reachable from the PUBLIC booking and invitation
// surfaces. Putting the constants in the prototype and importing them from
// there would have made the prototype reachable from `app/book/[slug]` and
// `app/invitation/[token]` — which is the precise thing its header promises is
// impossible. An earlier revision of this change did exactly that, and the
// reachability guard stayed green through it: its breadth-first walk keeps only
// the FIRST path it finds to each module and tests that path's root, so a
// sanctioned depth-1 path always won the race against the new depth-3
// violations and hid them. A rule nothing can fail is not a rule.
//
// So the values live here, where anything may import them, and the prototype
// re-exports them for its existing readers.
// ===========================================================================

/**
 * The bound is the shipped command's own: 1 hour .. 7 days.
 *
 * Out of range is REFUSED rather than clamped, because a clamped window is one
 * the caller did not ask for and cannot see. Every layer that re-checks does so
 * against these two constants — the composer's model, the adapter that receives
 * the submission, and the number input that advertises the range — so the four
 * statements of one rule that existed before this module cannot disagree.
 */
export const TTL_HOURS_MIN = 1;
export const TTL_HOURS_MAX = 168;

/**
 * THE OPPORTUNITY IS TWO DAYS.
 *
 * Every invitation offers the recipient 48 hours to book. It was 72, which is
 * not a bound being relaxed or tightened — `TTL_HOURS_MIN` and `TTL_HOURS_MAX`
 * are untouched and a studio may still choose any value in range. What changed
 * is the window a practitioner gets without deciding anything, and that is the
 * window nearly every invitation will actually carry.
 *
 * WHY THE SQL DEFAULT STILL SAYS 72, AND WHY THAT IS NOT A DISAGREEMENT.
 * `issue_new_client_waitlist_invitation(..., p_ttl_hours integer default 72)`
 * is unchanged, because changing it is a migration. That default is
 * UNREACHABLE: every TypeScript call site passes `p_ttl_hours` explicitly, so
 * the database's own fallback never fires.
 *
 * THERE ARE TWO CALL SITES, AND THE SECOND IS WHY THIS IS A CONSTANT RATHER
 * THAN AN EDIT IN ONE PLACE. `invite-to-book-adapter.ts` is the live one and
 * passes the composer's chosen value. `lib/booking/waitlist-invitation.ts`
 * (`issueScopedInvitation`) is DORMANT — nothing outside tests calls it — and
 * carried its own `?? 72` fallback. Left alone it would have woken up on the
 * old window, issuing 72-hour invitations from one surface while the composer
 * issued 48 from the other, with nothing failing in between.
 *
 * `tests/lib/waitlist/invitation-window.test.ts` censuses both facts: that no
 * call to a command taking `p_ttl_hours` omits the argument, and that none
 * states a numeric fallback of its own.
 */
export const TTL_HOURS_DEFAULT = 48;

/**
 * The windows the composer offers as one tap.
 *
 * EVERY PRESET MUST LIE INSIDE THE BOUND, and the test asserts it rather than
 * trusting the list. A preset outside the range is not a validation failure at
 * the type level — it is a radio button a practitioner can select and a
 * submission the adapter then refuses as `invalid_ttl`, which reads as the
 * product being broken rather than as the input being wrong.
 */
export const TTL_PRESETS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 24, label: "24 hours" },
  { hours: 48, label: "2 days" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
];

/**
 * The bound as the sentence a practitioner reads above the custom hours field.
 *
 * THE FOURTH STATEMENT OF THE BOUND, AND THE ONE NO CENSUS COULD SEE. The
 * composer's help text read "Hours, from 1 hour to 7 days" as a literal, one
 * line above the `min`/`max` this module now owns. A census that greps for
 * `min={<digits>}` cannot find a sentence, so narrowing `TTL_HOURS_MAX` would
 * have left the label promising seven days while the input beside it and the
 * adapter behind it both refused — which is the exact "reads as the product
 * being broken rather than as the input being wrong" case the composer's own
 * comment warns about.
 *
 * Derived, so it cannot say something the bound does not permit.
 */
export function ttlBoundLabel(): string {
  const unit = (hours: number): string => {
    if (hours % 24 === 0 && hours >= 24) {
      const days = hours / 24;
      return `${days} day${days === 1 ? "" : "s"}`;
    }
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  };
  return `Hours, from ${unit(TTL_HOURS_MIN)} to ${unit(TTL_HOURS_MAX)}`;
}
