// ===========================================================================
// THE INVITATION WINDOW — HOW LONG A RECIPIENT HAS TO BOOK
// ===========================================================================
//
// PURE, AND DELIBERATELY TINY. No import, no I/O, no server-only, so that every
// surface which needs to know the window can import it without dragging
// anything along.
//
// WHY THIS IS ITS OWN MODULE, AND NOT A SECTION OF b4-invitation-draft.ts.
// The composer's model is a PROTOTYPE: its header says "PURE, AND NOT REACHED
// BY THE APPLICATION", and `tests/lib/waitlist/b4-invitation-draft.test.ts`
// walks the import graph to prove exactly two sanctioned entry points reach it.
// The window is needed by surfaces reachable from `app/book/[slug]` and
// `app/invitation/[token]`, so putting it in the prototype would have made the
// prototype reachable from them — the precise thing its header promises is
// impossible. An earlier revision did exactly that and the reachability guard
// stayed green: its breadth-first walk keeps only the FIRST path to each module,
// so a sanctioned depth-1 path always won the race and hid the violations.
//
// So the values live here, where anything may import them.
// ===========================================================================

/**
 * THE WINDOW IS FIXED AT 48 HOURS, AND NOBODY CHOOSES IT.
 *
 * This is the whole product policy for a WAIT invitation: one canonical
 * opportunity, two days long, identical for every recipient. There is no
 * practitioner expiry question, no preset list and no custom value.
 *
 * WHY A FIXED WINDOW IS A DIFFERENT THING FROM A DEFAULT. A default is the
 * answer you get without deciding; alternatives still exist beside it, and any
 * surface that forgets to pass one silently lands somewhere else. #748 shipped
 * 48 as a DEFAULT — the constant was right and the product was still wrong,
 * because the composer went on offering 24, 48, 72, 168 and custom 1..168. A
 * practitioner could issue a 7-day opportunity by tapping one radio button.
 * This constant is now the ONLY window any application path can issue: no call
 * site accepts a TTL argument, so there is nothing left to forget to pass.
 *
 * WHY THE SQL DEFAULT STILL SAYS 72, AND WHY THAT IS NOT A DISAGREEMENT.
 * `issue_new_client_waitlist_invitation(..., p_ttl_hours integer default 72)`
 * is unchanged, because changing it is a migration and this slice is
 * zero-migration. That default is UNREACHABLE: every TypeScript call site
 * passes `p_ttl_hours` explicitly, and `tests/lib/waitlist/invitation-window.test.ts`
 * censuses that no call to a TTL-taking command omits the argument.
 *
 * THE DATABASE'S 1..168 SUPPORT IS DELIBERATELY LEFT INTACT. Removing a chooser
 * is a product decision; narrowing what the shipped command will accept is a
 * schema decision, and this slice makes only the first.
 *
 * THIS MODULE NO LONGER RESTATES THAT BOUND, AND THAT IS THE POINT.
 * It exported `TTL_HOURS_MIN = 1` and `TTL_HOURS_MAX = 168` so a test could
 * check 48 sat inside them. Nothing read them at runtime, and the check they
 * enabled was circular: it compared one TypeScript number against two other
 * TypeScript numbers and proved only that this file agreed with itself. If the
 * database's own guard ever changed, these copies would have gone on asserting
 * the old range and the test would have stayed green.
 *
 * The containment proof now DERIVES the accepted range from the SQL that
 * enforces it — `issue_new_client_waitlist_invitation`, which both application
 * paths reach — so it turns red when the real authority moves.
 * See `tests/lib/waitlist/invitation-window.test.ts`.
 */
export const WAIT_INVITATION_TTL_HOURS = 48;
