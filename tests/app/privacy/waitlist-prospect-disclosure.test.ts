import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ===========================================================================
// WAIT-02B STAGE B1 — THE DISCLOSURE, AND THE GATE THAT DEPENDS ON IT
// ===========================================================================
//
// These three facts are pinned in ONE file on purpose, because they are one
// fact split across three places:
//
//   1. app/privacy/page.tsx covers a prospective client who has not booked;
//   2. the public waitlist form says so at the point of collection and links
//      to the policy;
//   3. scripts/check-production-env-gates.mjs therefore no longer forbids
//      production from naming a studio.
//
// (3) was correct ONLY while (1) was false. Stage A's blanket prohibition
// existed because the notice scoped itself to practitioners and to clients
// whose details a practitioner enters, so a waitlist prospect fell outside
// every disclosed category. If (1) or (2) is ever deleted while (3) stays
// permissive, production could collect prospect data with no notice covering
// it — so deleting either one has to break the same test that permits the
// activation.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

const PRIVACY = read("app/privacy/page.tsx");
const FORM = read("app/book/[slug]/NewClientWaitlistForm.tsx");
const GATE = read("scripts/check-production-env-gates.mjs");

vi.mock("@/app/book/[slug]/waitlist-actions", () => ({
  submitNewClientBookingWaitlistAction: async () => ({ ok: true as const }),
}));

const { NewClientWaitlistForm } = await import(
  "@/app/book/[slug]/NewClientWaitlistForm"
);

const waitlistHtml = () =>
  renderToStaticMarkup(
    createElement(NewClientWaitlistForm, {
      slug: "willow-electrolysis",
      studioName: "Willow Electrolysis",
      onContinueAsExistingClient: () => {},
    }),
  );

// ---------------------------------------------------------------------------
// A. THE POLICY COVERS A PERSON WHO HAS NOT BOOKED
// ---------------------------------------------------------------------------
describe("privacy policy — prospective client / waitlist coverage", () => {
  it("SCOPE names prospective clients as a covered category, alongside the two that existed", () => {
    // The two pre-existing categories must survive: this adds a third, it does
    // not re-scope the policy.
    expect(PRIVACY).toMatch(/<strong>Practitioners<\/strong>/);
    expect(PRIVACY).toMatch(/<strong>Clients<\/strong>/);
    expect(PRIVACY).toMatch(/<strong>Prospective clients<\/strong>/);
  });

  it("says coverage does NOT depend on booking, or on a practitioner entering anything", () => {
    // The exact two implications Stage A recorded as untrue of the old notice.
    expect(PRIVACY).toMatch(/before becoming a client at all/);
    expect(PRIVACY).toMatch(/whether or not you ever book/);
    expect(PRIVACY).toMatch(
      /whether or not a practitioner has\s+ever entered anything about you/,
    );
  });

  it("has a collection section for information the PROSPECT supplies directly", () => {
    expect(PRIVACY).toMatch(/id="from-prospective-clients"/);
    expect(PRIVACY).toMatch(/From prospective clients directly/);
    expect(PRIVACY).toMatch(/no practitioner\s+enters it/);
    expect(PRIVACY).toMatch(/you do not need an account/);
  });

  it("enumerates exactly what the waitlist form actually collects, and no more", () => {
    // Name, email, optional phone, which studio, when, and the waiting/removed
    // status. That is the whole of new_client_waitlist_entries' personal data.
    expect(PRIVACY).toMatch(/Your name and email address/);
    expect(PRIVACY).toMatch(/Your phone number, if you choose to give one; it is optional/);
    expect(PRIVACY).toMatch(/Which studio&rsquo;s waitlist you joined, and when/);
    // Scoped: waiting/removed is a column on a stored entry. Where no entry is
    // stored there is no such status, so the bullet may not claim it outright.
    expect(PRIVACY).toMatch(
      /Where the studio keeps its waitlist with us, whether you are still\s+waiting, or have been removed/,
    );
  });

  it("does NOT over-claim: no health data is asked for, and no client record is created", () => {
    expect(PRIVACY).toMatch(/does not ask for health\s+information|does not ask for health information/);
    expect(PRIVACY).toMatch(
      /joining a waitlist does not create a client record, an\s+appointment, or an intake form/,
    );
  });

  it("states the PURPOSE the data is used for", () => {
    expect(PRIVACY).toMatch(
      /Run a studio&rsquo;s new-client waitlist on its behalf, and let that\s+studio contact you about availability/,
    );
  });

  it("states who the entry is shared with, and that it is single-studio", () => {
    expect(PRIVACY).toMatch(/With the studio whose waitlist you joined/);
    expect(PRIVACY).toMatch(/visible only to that studio/);
    expect(PRIVACY).toMatch(/not shared with any other\s+studio/);
  });

  // -------------------------------------------------------------------------
  // CODEX P1 (#637). The first draft of §6 said the entry "is emailed to that
  // studio" and that "We also email you an acknowledgement" — both stated as
  // fact. app/book/[slug]/waitlist-actions.ts guarantees NEITHER: a durable
  // join returns success when the studio has no valid owner_email, when the
  // provider refuses or throws (every send outcome is swallowed and logged),
  // and on `already_waiting`, which returns before any send is even scheduled.
  //
  // A privacy notice that promises delivery the code does not attempt is the
  // exact class of untruth this whole PR exists to remove, so the corrected
  // wording is pinned POSITIVELY (what is guaranteed) and NEGATIVELY (the
  // categorical phrasings that must never come back).
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // CODEX (#637), SECOND PASS. The §6 text said, of every waitlist request,
  // "we store it for that studio" and "Your entry is stored either way".
  // THERE ARE TWO COMMIT POINTS, chosen per studio by the server-only durable
  // allowlist (app/book/[slug]/waitlist-actions.ts, step 5):
  //
  //   WAIT-02 durable  — one row in new_client_waitlist_entries; the emails are
  //                      notifications on top of it, and failure cannot retract
  //                      it. THIS is the path the old wording described.
  //   WAIT-01 legacy   — NO record on Hone's side at all. The studio email IS
  //                      the request; a refusal or a missing recipient FAILS the
  //                      submission and the visitor is told so.
  //
  // The allowlist ships naming NO studio, so at publication the unconditional
  // wording was false for every submission the form actually takes. A privacy
  // notice claiming durable storage that does not happen is the same class of
  // untruth as the delivery promise removed above, in the opposite direction.
  // -------------------------------------------------------------------------
  it("distinguishes the two handlings instead of claiming one for everybody", () => {
    // The disjunction itself, stated without asserting which studios are which.
    expect(PRIVACY).toMatch(
      /<strong>What happens to your request depends on the studio\.<\/strong>/,
    );
    expect(PRIVACY).toMatch(
      /new-client waitlist is either kept with us as a stored\s+record, or not kept by us at all/,
    );
    // Which one applies is knowable on request, not left as a mystery.
    expect(PRIVACY).toMatch(/Which applies is a setting on the\s+studio, not on you/);
    expect(PRIVACY).toMatch(/Ask the studio, or write to\{" "\}/);
  });

  it("guarantees STORAGE only WHERE the waitlist is kept with us", () => {
    // The strong guarantee survives — scoped to the path that earns it.
    expect(PRIVACY).toMatch(
      /<strong>Where the waitlist is kept with us<\/strong>, your entry is\s+recorded when you submit it/,
    );
    expect(PRIVACY).toMatch(/<strong>Your entry is stored either way\.<\/strong>/);
    expect(PRIVACY).toMatch(
      /A\s+notification that never arrives does not mean your request was not\s+recorded/,
    );
    // ORDERING: the guarantee must sit INSIDE the scoped paragraph, not before
    // it, or the scope is decorative. Both live in one <P>; the next <P> opens
    // after the guarantee.
    const scope = PRIVACY.indexOf("<strong>Where the waitlist is kept with us</strong>");
    const guarantee = PRIVACY.indexOf("<strong>Your entry is stored either way.</strong>");
    expect(scope).toBeGreaterThan(-1);
    expect(guarantee).toBeGreaterThan(scope);
    expect(PRIVACY.slice(scope, guarantee)).not.toContain("</P>");
  });

  it("states the legacy path truthfully: no record, and no false success", () => {
    expect(PRIVACY).toMatch(
      /<strong>Where it is not kept with us<\/strong>, we keep no waitlist\s+entry for you at all/,
    );
    // The email is the request, not a notification about a record.
    expect(PRIVACY).toMatch(
      /that message is the request itself\s+rather than a notification about a record on our side/,
    );
  });

  // -------------------------------------------------------------------------
  // CODEX (#637), FOURTH PASS — P2. The paragraph above once ended, in wording
  // now removed: "If the message is not accepted, we tell you the request did
  // not go through" (SWEEP-EXEMPT: quoted, not asserted).
  // That collapses THREE runtime outcomes into two. WAIT-01 has:
  //
  //   no recipient          -> SUBMIT_FAILED       "we couldn't record it"
  //   definite refusal      -> SUBMIT_FAILED       "we couldn't record it"
  //   AMBIGUOUS (timeout /  -> SUBMIT_UNCONFIRMED  "we couldn't CONFIRM it —
  //   concurrent / no id)                           contact the studio"
  //
  // The third is also "not accepted", but Hone does NOT tell the visitor the
  // request failed there — it says it could not establish what happened. The
  // categorical sentence was therefore false in exactly the branch that exists
  // because the outcome is unknowable.
  // -------------------------------------------------------------------------
  it("splits DEFINITE failure from an UNCERTAIN outcome, as the code does", () => {
    // 1. The definite branch is described by WHAT HONE KNOWS — a known
    //    non-send — with causes as EXAMPLES, not as an exhaustive list. An
    //    enumeration is what went stale last time: it named provider refusal
    //    and no-recipient, and missed the locally-rejected sends.
    expect(PRIVACY).toMatch(
      /If we know the request was not sent\s+&mdash; for example because there is no studio email address available,\s+or because the send cannot be started or is refused &mdash; we tell you\s+the request did not go through/,
    );
    // 2. The uncertain branch says "could not confirm", never "failed".
    expect(PRIVACY).toMatch(
      /If the outcome is uncertain instead,\s+meaning we tried and could not establish what happened, we tell you we\s+could not confirm your request, and ask you to contact the studio\s+before trying again/,
    );
    // 3. Stated as a rule, so the distinction cannot be read as incidental.
    expect(PRIVACY).toMatch(/We do not describe an uncertain outcome as a\s+failure/);
    // ...and neither branch claims a join.
    expect(PRIVACY).toMatch(/in neither case do we tell you that\s+you joined/);
    // No internal vocabulary leaks into the WAITLIST copy. Scoped to §6's
    // waitlist paragraphs on purpose: the subprocessor list higher up in §6
    // names the email provider, and that is a required disclosure which
    // predates this PR — it must not be collateral damage of this check.
    const waitlist = PRIVACY.slice(
      PRIVACY.indexOf("<strong>With the studio whose waitlist you joined.</strong>"),
      PRIVACY.indexOf("<strong>In connection with a business transfer</strong>"),
    );
    expect(waitlist.length).toBeGreaterThan(500); // anti-vacuity
    for (const internal of [
      "SUBMIT_FAILED", "SUBMIT_UNCONFIRMED", "message id", "message ID",
      "idempotency", "Resend", "ambiguous", "provider",
    ]) {
      expect(waitlist, `waitlist copy must not expose "${internal}"`).not.toContain(internal);
    }
    // ...and the pre-existing subprocessor disclosure is still there.
    expect(PRIVACY).toContain("Resend (transactional email delivery)");
  });

  it("NEGATIVE CONTROL: 'not accepted' may never be reported as definite failure", () => {
    for (const banned of [
      /\bIf the message is not accepted\b/i,
      /\bif (?:it|the message|the email) is not accepted\b/i,
      /\bnot accepted, we tell you\b/i,
      /\bevery (?:message|send|attempt|request)[^.]{0,40}not accepted\b/i,
      /\banything not accepted\b/i,
    ]) {
      expect(PRIVACY, `must not collapse the uncertain branch: ${banned}`).not.toMatch(banned);
    }
  });

  it("ANTI-VACUITY: the runtime really does return two different results", () => {
    const action = read("app/book/[slug]/waitlist-actions.ts");
    const lib = read("lib/booking/new-client-waitlist.ts");
    // The ambiguous branch is checked FIRST and returns UNCONFIRMED...
    expect(action).toMatch(
      /if \(studioSend\.status === "ambiguous"\)[\s\S]{0,260}return \{ ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_UNCONFIRMED \};/,
    );
    // ...and only a DEFINITE non-acceptance falls through to FAILED.
    expect(action).toMatch(
      /if \(studioSend\.status !== "accepted"\)[\s\S]{0,320}return \{ ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED \};/,
    );
    // The no-recipient case is the other definite one.
    expect(action).toMatch(
      /new_client_waitlist_no_studio_recipient[\s\S]{0,200}NEW_CLIENT_WAITLIST_SUBMIT_FAILED/,
    );
    // AND THE LOCALLY-KNOWN NON-SEND, which is why the policy describes a
    // CATEGORY rather than listing causes. With no transport configured the
    // sender rejects before contacting anything, so a definite failure occurs
    // with no provider refusal and a perfectly good studio address. An
    // enumeration of "refusal or no recipient" missed exactly this.
    const sender = read("lib/email/new-client-waitlist-send.ts");
    expect(sender).toMatch(
      /if \(!transport\) return \{ status: "rejected", code: "not_configured" \};/,
    );
    // "rejected" is neither "ambiguous" nor "accepted", so it lands in the
    // definite branch above — the same treatment as a refusal.
    expect(sender).toMatch(/\| \{ status: "rejected"; code: string \| null \}/);
    // Sibling local rejections share that status, so the category holds for
    // them too rather than needing another clause each.
    expect(sender).toMatch(/status: "rejected", code: "invalid_recipient"/);
    expect(sender).toMatch(/status: "rejected", code: "missing_tenant_scope"/);
    // And the two visitor-facing strings really are different messages: one
    // says we could not RECORD it, the other that we could not CONFIRM it.
    const failed = lib.match(/NEW_CLIENT_WAITLIST_SUBMIT_FAILED =\s*\n\s*"([^"]+)"/)?.[1];
    const unconfirmed = lib.match(/NEW_CLIENT_WAITLIST_SUBMIT_UNCONFIRMED =\s*\n\s*"([^"]+)"/)?.[1];
    expect(failed).toBeTruthy();
    expect(unconfirmed).toBeTruthy();
    expect(failed).not.toBe(unconfirmed);
    expect(failed as string).toMatch(/couldn.t record/i);
    expect(unconfirmed as string).toMatch(/couldn.t confirm/i);
    expect(unconfirmed as string).toMatch(/contact the studio/i);
  });

  // -------------------------------------------------------------------------
  // CODEX (#637), THIRD PASS — P1. The paragraph above previously ended "From
  // that point your details are held by the studio, in its own systems", and
  // §9 said what persists is "the email carrying your request — in the
  // studio's mailbox". Both assert DELIVERY.
  //
  // submitViaStudioNotification() returns success on `studioSend.status ===
  // "accepted"`, and waitlist-actions.ts states in terms what that means:
  // Resend accepted the request AND returned an id. It is NOT inbox delivery,
  // recipient acceptance, non-spam placement, or that a human saw it. A later
  // bounce therefore leaves NO Hone row and NO mailbox copy — the request
  // exists nowhere — while the visitor was already told it went through.
  //
  // So the policy may state the ATTEMPT and the ACCEPTANCE. It may not state
  // arrival, and it may not state that the studio holds anything.
  // -------------------------------------------------------------------------
  it("distinguishes accepted-for-sending from delivered, in plain language", () => {
    expect(PRIVACY).toMatch(/Instead we <strong>attempt to send<\/strong> your/);
    expect(PRIVACY).toMatch(
      /our email service accepted the message for sending; that\s+is not the same as the studio receiving it/,
    );
    expect(PRIVACY).toMatch(/we cannot promise it\s+arrives/);
    // Retention says the same thing, and refuses to promise a deletion of
    // something never stored.
    expect(PRIVACY).toMatch(/We cannot promise it\s+arrived, and we cannot tell you that any such copy exists/);
    expect(PRIVACY).toMatch(
      /we will not claim to delete a record we\s+never held/,
    );
  });

  it("NEGATIVE CONTROL: WAIT-01 success may never imply persistence anywhere", () => {
    // The two exact phrasings that were wrong.
    expect(PRIVACY).not.toMatch(/your details are held by the studio/i);
    expect(PRIVACY).not.toMatch(/in the\s+studio&rsquo;s mailbox/i);
    // ...and the shapes they would return as. Each asserts that a copy EXISTS
    // after a submission Hone only knows was accepted for sending.
    for (const banned of [
      /\bthe email persists\b/i,
      /\bpersists in the studio\b/i,
      /\bthe studio (?:holds|retains|keeps|has) your (?:request|details|information)\b/i,
      /\bis (?:held|retained|stored) by the studio\b/i,
      /\ba copy (?:remains|exists|is kept) in the studio\b/i,
      /\bthe studio(?:&rsquo;s|'s)? mailbox (?:holds|keeps|retains)\b/i,
    ]) {
      expect(PRIVACY, `must not assert studio-side persistence: ${banned}`).not.toMatch(banned);
    }
    // Hedged forms are the point, so they must survive: "may remain", "may keep".
    expect(PRIVACY).toMatch(/copies of it may remain in/);
    expect(PRIVACY).toMatch(/the studio may keep it under its own\s+practices/);
  });

  it("ANTI-VACUITY: provider acceptance really is all the code knows", () => {
    const action = read("app/book/[slug]/waitlist-actions.ts");
    // The commit law itself: accepted -> success.
    expect(action).toMatch(/if \(studioSend\.status !== "accepted"\)/);
    // And the file says, in terms, that acceptance is not delivery.
    expect(action).toMatch(
      /"Accepted" means the Resend API accepted the request AND returned an id for\s*\n\/\/ it\. It does NOT mean inbox delivery/,
    );
    // WAIT-01 writes NO row: the only rpc in the file is the durable path's.
    const legacy = action.slice(
      action.indexOf("async function submitViaStudioNotification"),
      action.indexOf("export async function submitNewClientBookingWaitlistAction"),
    );
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy).not.toMatch(/\.rpc\(/);
    expect(legacy).not.toMatch(/join_new_client_waitlist/);
  });

  it("NEGATIVE CONTROL: the unconditional storage claim cannot come back", () => {
    // The exact phrasing that was wrong.
    expect(PRIVACY).not.toMatch(/we store it for that studio/i);
    // ...and the shapes it would return as. Each asserts a record for EVERY
    // request, which is false while any studio sits on the WAIT-01 commit
    // point. None of these matches the scoped guarantee, which is phrased
    // "Your entry is stored either way." and lives inside the kept-with-us
    // paragraph — that sentence is checked separately, below.
    for (const banned of [
      /\bwe (?:always |will )?store (?:it|them|your entry|your request|every|all)\b/i,
      /\bevery (?:waitlist )?(?:request|entry|submission) is (?:stored|recorded|kept)\b/i,
      /\ball waitlist (?:requests|entries|submissions) are (?:stored|recorded|kept)\b/i,
      /\bwe keep a record of every\b/i,
      /\bis stored regardless\b/i,
    ]) {
      expect(PRIVACY, `must not claim universal storage: ${banned}`).not.toMatch(banned);
    }
  });

  it("NEGATIVE CONTROL: the scoped guarantee exists ONCE, and only in its own scope", () => {
    // A second copy of "stored either way" somewhere unscoped would restore the
    // untruth while leaving every assertion above green.
    const guarantee = "Your entry is stored either way.";
    const hits = [...PRIVACY.matchAll(/Your entry is stored either way\./g)];
    expect(hits, `expected exactly one "${guarantee}"`).toHaveLength(1);

    const at = hits[0].index as number;
    const scope = PRIVACY.lastIndexOf(
      "<strong>Where the waitlist is kept with us</strong>",
      at,
    );
    expect(scope, "the guarantee must follow its scoping clause").toBeGreaterThan(-1);
    // ...and inside the SAME paragraph: no </P> may intervene.
    expect(PRIVACY.slice(scope, at)).not.toContain("</P>");
  });

  it("ANTI-VACUITY: the code really does have two commit points, and ships on the legacy one", () => {
    // If there were only one path, the scoping above would be noise. Pin the
    // branch, and that the durable one is opt-in per studio.
    const action = read("app/book/[slug]/waitlist-actions.ts");
    expect(action).toMatch(
      /isNewClientWaitlistDurableEnabled\(studio\.slug\)\s*\?\s*submitToDurableWaitlist[\s\S]{0,120}submitViaStudioNotification/,
    );
    // The legacy path fails the submission when the studio email cannot be
    // sent — i.e. nothing is recorded and the visitor is not told they joined.
    expect(action).toMatch(
      /new_client_waitlist_no_studio_recipient[\s\S]{0,200}NEW_CLIENT_WAITLIST_SUBMIT_FAILED/,
    );
    // And the durable path is OFF unless a studio is named in the allowlist.
    const lib = read("lib/booking/new-client-waitlist.ts");
    expect(lib).toMatch(/DEFAULT OFF/);
    expect(lib).toMatch(/return slugIsListed\(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, studioSlug\)/);
  });

  it("does NOT guarantee email delivery — notification is attempted, not promised", () => {
    expect(PRIVACY).toMatch(/We also try to notify that studio by email/);
    expect(PRIVACY).toMatch(/to send you an\s+acknowledgement that you joined/);
    expect(PRIVACY).toMatch(/<strong>attempted, not guaranteed<\/strong>/);
    expect(PRIVACY).toMatch(/a message can fail to\s+send\s+or fail to arrive/);
    // The no-recipient case is a real production state, not a hypothetical.
    expect(PRIVACY).toMatch(/a studio may have no email address set up to\s+receive one/);
  });

  it("NEGATIVE CONTROL: the categorical delivery claims cannot come back", () => {
    // The two exact phrasings Codex flagged.
    expect(PRIVACY).not.toMatch(/is emailed to that studio/i);
    expect(PRIVACY).not.toMatch(/We also email you an acknowledgement/i);
    // ...and the shapes they would return as. Each asserts delivery of a
    // waitlist message as a fact rather than an attempt.
    for (const banned of [
      /\bwe (?:will |always )?email you\b/i,
      /\bwe (?:will |always )?email the studio\b/i,
      /\bwe (?:will |always )?email that studio\b/i,
      /\byou will receive an (?:email|acknowledgement)\b/i,
      /\bthe studio will receive\b/i,
      /\bis (?:emailed|sent) to the studio\b/i,
      /\bguarantee\w* (?:delivery|that .{0,40}email)\b/i,
    ]) {
      expect(PRIVACY, `must not promise delivery: ${banned}`).not.toMatch(banned);
    }
  });

  it("ANTI-VACUITY: the code really does treat delivery as best effort", () => {
    // If the implementation ever DID guarantee delivery, the hedged wording
    // above would be the untruth and this block would be protecting the wrong
    // thing. Pin the three success-without-send paths that make it correct.
    const action = read("app/book/[slug]/waitlist-actions.ts");
    // 1. already_waiting returns before any send is scheduled.
    expect(action).toMatch(
      /if \(commandResult === "already_waiting"\)[\s\S]{0,400}?return \{ ok: true \};/,
    );
    // 2. no studio recipient: logged, and the join still succeeds.
    expect(action).toMatch(/new_client_waitlist_no_studio_recipient/);
    // 3. every acknowledgement outcome, including a throw, is swallowed.
    expect(action).toMatch(/new_client_waitlist_client_email_threw/);
  });

  it("does not imply a waitlist join creates an appointment or client record", () => {
    expect(PRIVACY).toMatch(
      /Under either handling, joining a waitlist does not create an\s+appointment, a client record, or an intake form for you/,
    );
  });

  it("keeps the collection surface's truthful 'contact you about availability' wording", () => {
    // Deliberately UNCHANGED by the P1 repair: it already promised only that
    // the studio may contact you, never that an email is delivered.
    expect(FORM).toContain("contact you about availability");
    expect(FORM).not.toMatch(/\bwe (?:will |always )?email you\b/i);
  });

  it("gives a prospect a removal / access route that does not need an account", () => {
    expect(PRIVACY).toMatch(/If you joined a studio&rsquo;s new-client waitlist<\/strong>/);
    expect(PRIVACY).toMatch(/contact the studio/);
    expect(PRIVACY).toMatch(/privacy@hone\.care/);
    expect(PRIVACY).toMatch(/You do not need\s+an account with us to make either request/);
  });

  // THE ONE THE STAGE-A RECORD CALLED OUT: no retention policy covers this data
  // yet. The policy must say that truthfully rather than invent a period.
  it("describes waitlist retention TRUTHFULLY and invents no statutory period", () => {
    expect(PRIVACY).toMatch(
      /A <strong>stored new-client waitlist entry<\/strong> &mdash; one held for\s+a studio whose waitlist is kept with us, as section 6 describes &mdash;\s+is kept for as long as the studio keeps it/,
    );
    // Removal is a terminal status transition that RETAINS the row. Say so.
    expect(PRIVACY).toMatch(/marked as removed and retained/);
    expect(PRIVACY).toMatch(/We do not\s+currently run an automatic timed purge of waitlist entries/);
    expect(PRIVACY).toMatch(/we do\s+not claim any fixed retention period for them/);
  });

  it("says what is retained where NO entry of ours exists — hedged, not asserted", () => {
    expect(PRIVACY).toMatch(
      /Where a studio&rsquo;s waitlist is <strong>not<\/strong> kept with us,\s+we keep no waitlist entry for you, so there is nothing on our side to\s+retain and nothing for us to delete/,
    );
    // What MAY persist, and whose practices govern it. Every verb hedged,
    // because provider acceptance is all Hone ever knows. No invented period,
    // and no provider named in the public copy.
    expect(PRIVACY).toMatch(/We attempt to send your request to\s+the studio by email/);
    expect(PRIVACY).toMatch(
      /copies of it may remain in\s+the studio&rsquo;s systems and in the email systems that carried it/,
    );
    expect(PRIVACY).toMatch(/under their retention practices rather than ours/);
  });

  // -------------------------------------------------------------------------
  // CODEX (#637), THIRD PASS — P2-A. §6 said "write to privacy@hone.care and we
  // will tell you" which handling applies, and §8 promised to "tell you which
  // of the two handlings in section 6 applies". Hone cannot honour that for a
  // PAST request:
  //
  //   * WAIT-01 writes no row, so nothing records that the request existed;
  //   * the mode is read from process.env per call (UNCACHED, by design), so
  //     only the CURRENT value is knowable;
  //   * a studio can be added to the durable allowlist later, which rewrites
  //     the answer the current config gives for an older submission;
  //   * new_client_waitlist_entries has no column recording the handling, and
  //     join_new_client_waitlist takes no such argument.
  //
  // The repair QUALIFIES the promise rather than adding storage to satisfy it.
  // -------------------------------------------------------------------------
  it("promises only the CURRENT handling, never a historical reconstruction", () => {
    expect(PRIVACY).toMatch(
      /we can tell you how that\s+studio&rsquo;s waitlist is handled <strong>now<\/strong>/,
    );
    expect(PRIVACY).toMatch(
      /We do not\s+record, for each request, which handling was in force when it was made/,
    );
    expect(PRIVACY).toMatch(
      /for an earlier request we may not be able to establish\s+afterwards which of the two applied/,
    );
    // §8 keeps the access route USEFUL where a record exists, and honest where
    // it does not.
    expect(PRIVACY).toMatch(
      /Where we hold a\s+waitlist entry for you we can find it and act on it/,
    );
    expect(PRIVACY).toMatch(
      /we may not be able to tell\s+you afterwards which handling applied or whether the message reached the\s+studio/,
    );
  });

  it("NEGATIVE CONTROL: no unconditional promise to identify a past handling", () => {
    for (const banned of [
      /\bwe will tell you which handling\b/i,
      /\bwe (?:will|can) tell you which of the two handlings\b(?![\s\S]{0,40}now)/i,
      /\bwe will assist and tell you\b/i,
      /\bwe can always tell you\b/i,
      /\bwe (?:will|can) determine which handling applied\b/i,
      /\bwe keep a record of which handling\b/i,
    ]) {
      expect(PRIVACY, `must not promise historical reconstruction: ${banned}`).not.toMatch(banned);
    }
  });

  it("ANTI-VACUITY: nothing in the architecture records the handling per request", () => {
    const action = read("app/book/[slug]/waitlist-actions.ts");
    const lib = read("lib/booking/new-client-waitlist.ts");
    const migration = read("supabase/migrations/0185_new_client_waitlist_entries.sql");

    // Mode comes from CURRENT config, read per call rather than cached.
    expect(lib).toMatch(/return parseWaitlistSlugs\(process\.env\[envVar\]\)\.has\(slug\)/);
    expect(lib).toMatch(/UNCACHED/);

    // The durable command carries no handling/mode argument...
    expect(action).toMatch(/rpc\("join_new_client_waitlist", \{/);
    const call = action.slice(action.indexOf('rpc("join_new_client_waitlist"'));
    const args = call.slice(0, call.indexOf("}"));
    for (const forbidden of ["handling", "mode", "commit_point", "durable"]) {
      expect(args.toLowerCase(), `rpc args must not carry ${forbidden}`).not.toContain(forbidden);
    }
    // ...and the table has no column to put one in. SQL comments are stripped
    // first, so this asserts something about the COLUMNS rather than about the
    // prose that documents them.
    const table = migration.slice(
      migration.indexOf("create table if not exists public.new_client_waitlist_entries"),
    );
    const columns = table
      .slice(0, table.indexOf(");"))
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n")
      .toLowerCase();
    expect(columns).toContain("status text not null default 'waiting'"); // anti-vacuity
    for (const forbidden of ["handling", "commit_point", "durable", "wait_01", "wait01"]) {
      expect(columns, `table must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("invents no new statutory retention number anywhere", () => {
    // The ONLY numeric retention claim the policy may carry is the pre-existing
    // billing-records line; nothing in this revision may add a second.
    const years = [...PRIVACY.matchAll(/(\d+)\s*years?/gi)].map((m) => m[0]);
    expect(years).toEqual(["7 years"]);
  });
});

// ---------------------------------------------------------------------------
// B. THE POLICY DATES
// ---------------------------------------------------------------------------
describe("policy dates — the section 13 rule is stated, not invented", () => {
  it("keeps the 30-day account-holder notice promise verbatim", () => {
    expect(PRIVACY).toMatch(
      /Material changes will be\s+communicated via email to account holders at least 30 days before\s+taking effect/,
    );
  });

  it("explains what the two header dates mean, so a revision is not read as retroactive", () => {
    expect(PRIVACY).toMatch(/<strong>Effective date<\/strong> is when this policy took effect/);
    expect(PRIVACY).toMatch(/<strong>Last updated<\/strong> is when its text was last revised/);
    expect(PRIVACY).toMatch(/We\s+do not apply a revision retroactively/);
  });

  it("carries the effective date in ONE named constant, so the operator edits one line", () => {
    expect(PRIVACY).toMatch(/const EFFECTIVE_DATE = "[^"]+";/);
    expect(PRIVACY).toMatch(/const LAST_UPDATED = "[^"]+";/);
    expect(PRIVACY).toMatch(/effectiveDate=\{EFFECTIVE_DATE\}/);
    expect(PRIVACY).toMatch(/lastUpdated=\{LAST_UPDATED\}/);
  });

  it("records that the effective date is an operator/legal decision, not a repository one", () => {
    expect(PRIVACY).toMatch(/notice date \+ 30 days/);
    expect(PRIVACY).toMatch(/THIS CONSTANT IS THE ONE PLACE THAT CHANGES/);
  });

  it("the revision moved lastUpdated forward without back-dating the text", () => {
    const effective = PRIVACY.match(/const EFFECTIVE_DATE = "([^"]+)";/)?.[1];
    const lastUpdated = PRIVACY.match(/const LAST_UPDATED = "([^"]+)";/)?.[1];
    expect(effective).toBeTruthy();
    expect(lastUpdated).toBeTruthy();
    expect(Date.parse(lastUpdated as string)).toBeGreaterThan(
      Date.parse(effective as string),
    );
  });
});

// ---------------------------------------------------------------------------
// C. THE COLLECTION SURFACE
// ---------------------------------------------------------------------------
describe("public waitlist form — notice at the point of collection", () => {
  const html = waitlistHtml();

  it("names WHO handles it, WHAT is collected, and WHY", () => {
    expect(html).toContain("Willow Electrolysis and Hone use");
    expect(html).toContain("the name, email and phone number you enter here");
    expect(html).toContain("to manage this waitlist and contact you about availability");
  });

  // The notice is rendered by a CLIENT component that deliberately does not
  // know which commit point the studio is on — learning it would put a
  // server-only activation fact in the browser bundle for a caption. So the
  // wording has to be true under BOTH, which rules out "store".
  it("does not promise storage the studio's commit point may not provide", () => {
    expect(html).not.toMatch(/\bHone will store\b/i);
    expect(html).not.toMatch(/\b(?:we|Hone) (?:will |always )?(?:store|keep|save|record)s? (?:it|your|the name)\b/i);
    // And the component must not have acquired the flag to work around it:
    // no predicate, no env read, and no prop carrying the answer into the
    // browser. (The comment above it may — and does — explain WHY not.)
    expect(FORM).not.toMatch(/isNewClientWaitlistDurableEnabled/);
    expect(FORM).not.toMatch(/process\.env/);
    expect(FORM).not.toMatch(/NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS/);
    expect(FORM).toMatch(
      /export function NewClientWaitlistForm\(\{\s*slug,\s*studioName,\s*onContinueAsExistingClient,\s*\}: \{\s*slug: string;\s*studioName: string;\s*onContinueAsExistingClient: \(\) => void;\s*\}\)/,
    );
  });

  // The browser lane asserts this same notice is VISIBLE at 390px, by locating
  // it with a text regex. That regex lives in another file and cannot see this
  // constant, so a copy edit here is exactly how the extended shard goes red
  // twenty minutes later for a reason that has nothing to do with the browser.
  // Check the agreement here, in milliseconds.
  it("the e2e locator for this notice still matches what the form renders", () => {
    const spec = read("e2e/new-client-waitlist.spec.ts");
    const source = spec.match(
      /const collectionNotice = page\.getByText\(\s*\/([^\n]*?)\/([a-z]*),?\s*\)/,
    );
    expect(source, "e2e spec must still locate the notice by text regex").toBeTruthy();
    const [, pattern, flags] = source as RegExpMatchArray;
    expect(html).toMatch(new RegExp(pattern, flags));
  });

  it("links to the privacy policy from the collection surface itself", () => {
    expect(html).toMatch(/<a[^>]*href="\/privacy"[^>]*>/);
    expect(html).toMatch(/Privacy Policy<\/a>/);
  });

  it("is NOT hidden, collapsed, or visually suppressed", () => {
    const at = html.indexOf("Willow Electrolysis and Hone use");
    // From the notice's own <p ...> tag, so its class/style attributes are in
    // scope — they sit before the text, not after it.
    const notice = html.slice(html.lastIndexOf("<p", at));
    // Same 13px secondary type as the existing not-a-reservation line, which
    // is the form's established caption size — not smaller, not lighter.
    expect(notice).toContain("text-[13px]");
    expect(notice).not.toMatch(/<details|hidden|sr-only|display:\s*none|opacity:\s*0|font-size:\s*(?:[0-9]|10|11)px/);
    // The link is underlined and inked, not blended into the muted body.
    expect(notice).toMatch(/underline/);
  });

  it("sits WITH the submit control, not in a footer far from it", () => {
    const cta = html.indexOf("Join waitlist");
    const notice = html.indexOf("Willow Electrolysis and Hone use");
    expect(cta).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(cta);
    // Adjacent: only the not-a-reservation caption sits between them.
    expect(html.slice(cta, notice)).not.toContain("</form>");
  });

  it("adds NO consent checkbox — this collection is not separable from the request", () => {
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    expect(inputs).toHaveLength(3); // name, email, phone — unchanged
    expect(html).not.toContain('type="checkbox"');
  });

  it("keeps the existing copy discipline: no capacity, queue or position signal", () => {
    const lower = html.toLowerCase();
    for (const forbidden of [
      "utilization", "utilisation", "capacity", "queue", "position",
      "conversion", "%", "critical", "fully booked",
    ]) {
      expect(lower, `notice must not introduce "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("the CONFIRMATION panel is untouched — it carries no new outcome-bearing copy", () => {
    // The panel receives only studioName, and this change must not have given
    // it anything that could vary with which database outcome occurred.
    expect(FORM).toMatch(/NewClientWaitlistJoinedPanel\(\{ studioName \}: \{ studioName: string \}\)/);
    expect(FORM).not.toMatch(/JoinedPanel[\s\S]{0,400}COLLECTION_NOTICE/);
  });
});

// ---------------------------------------------------------------------------
// E. THE SAME-CLAIM SWEEP
// ---------------------------------------------------------------------------
//
// FOUR REVIEW ROUNDS, AND TWICE THE SAME SHAPE OF DEFECT: the behaviour was
// repaired and an old DESCRIPTION of that behaviour was left standing in
// another file. Round four found the WAIT-01 failure taxonomy stated the old
// way in the risk register, and the withdrawn hard-fail gate still promised in
// the runtime module comment — and a manual sweep then found it a THIRD time,
// in this suite's sibling test header.
//
// Every negative control before this one is scoped to a single file, so none of
// them could see any of that. This one is scoped to the CONTRACT, across every
// file PR #637 owns.
//
// HOW HISTORY IS ALLOWED. Narrating a repaired defect is legitimate and worth
// keeping — it is why the current wording is what it is. Two things keep such
// prose out of the way here:
//
//   1. the patterns match the claim only in the PRESENT tense, so "a production
//      build aborted while..." and "an earlier draft aborted the build" pass
//      untouched, while "the build aborts if..." does not;
//   2. a line carrying the token SWEEP-EXEMPT is skipped outright. That covers
//      the two cases where the words have to appear verbatim and are not a
//      claim: a comment quoting the old sentence, and this suite's own
//      representative fixtures.
//
// Adding a file to #637 means adding it here.
// ---------------------------------------------------------------------------
describe("no file states a repaired WAIT-02B contract the old way", () => {
  const OWNED = [
    "app/privacy/page.tsx",
    "app/book/[slug]/NewClientWaitlistForm.tsx",
    "docs/03_SECURITY_AND_PRIVACY.md",
    "docs/10_DEPLOYMENT_AND_ENV.md",
    "lib/booking/new-client-waitlist.ts",
    "scripts/check-production-env-gates.mjs",
    "e2e/new-client-waitlist.spec.ts",
    "tests/app/privacy/waitlist-prospect-disclosure.test.ts",
    "tests/scripts/check-production-env-gates.test.ts",
    "tests/lib/booking/new-client-waitlist-flag.test.ts",
    "tests/app/book/new-client-waitlist-durable-commit.test.ts",
  ];

  /** FAMILY A — the WAIT-01 failure / delivery taxonomy. */
  const FAILURE_TAXONOMY = [
    /(?:any|every|a) (?:message|submission|send|request)[^.\n]{0,60}not accepted[^.\n]{0,60}(?:is|are) reported as (?:a )?fail/i,
    /not accepted[^.\n]{0,40}we tell you the request did not go through/i,
    /we can tell you that (?:such )?a (?:mailbox )?copy exists/i,
    /(?:we|hone) can always (?:tell|determine) which handling/i,
  ];

  /** FAMILY B — the Stage-B activation-gate semantics. */
  const GATE_SEMANTICS = [
    /production build (?:still )?aborts (?:if|when) an entry/i,
    /build aborts (?:if|when|on)[^.\n]{0,60}(?:studio slug|slug convention)/i,
    /green (?:check|gate|build) proves activation/i,
    /wildcard[^.\n]{0,40}enables every studio/i,
  ];

  function scan(patterns: RegExp[]): string[] {
    const hits: string[] = [];
    for (const rel of OWNED) {
      read(rel).split("\n").forEach((line, i) => {
        if (line.includes("SWEEP-EXEMPT")) return;
        for (const p of patterns) {
          if (p.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    return hits;
  }

  it("ANTI-VACUITY: every owned file is readable and non-trivial", () => {
    // A typo in a path would silently scan nothing and pass forever.
    for (const rel of OWNED) {
      expect(read(rel).length, `${rel} must be readable`).toBeGreaterThan(200);
    }
  });

  it("FAMILY A: no file reports every non-accepted send as a definite failure", () => {
    expect(scan(FAILURE_TAXONOMY)).toEqual([]);
  });

  it("FAMILY B: no file claims the build aborts over an allowlist entry", () => {
    expect(scan(GATE_SEMANTICS)).toEqual([]);
  });

  it("ANTI-VACUITY: the representative stale claims really would be caught", () => {
    // If these ever stop matching, the two tests above are decorative. This is
    // the check that the patterns have teeth, done in memory rather than by
    // editing a file.
    const A = "any message not accepted is reported as failed"; // SWEEP-EXEMPT
    const B = "production build aborts when an entry cannot be a studio slug"; // SWEEP-EXEMPT
    expect(FAILURE_TAXONOMY.some((p) => p.test(A)), `family A must catch: ${A}`).toBe(true);
    expect(GATE_SEMANTICS.some((p) => p.test(B)), `family B must catch: ${B}`).toBe(true);
    // ...and past-tense narration of the same facts must NOT be caught.
    for (const historical of [
      "a production build aborted while the allowlist named any studio",
      "an earlier draft aborted the build on any entry outside the shape",
      "Under Stage A this exact case aborted the build.",
    ]) {
      expect(
        GATE_SEMANTICS.some((p) => p.test(historical)),
        `history must stay legal: ${historical}`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// D. THE COUPLING: the gate may only be permissive while the disclosure exists
// ---------------------------------------------------------------------------
describe("the activation guard rests on the disclosure above", () => {
  it("the Stage-A blanket prohibition is gone", () => {
    expect(GATE).not.toMatch(/stage-a-durable-waitlist-env/);
    expect(GATE).toMatch(/stage-b-durable-waitlist-env/);
  });

  it("the gate cites the disclosure it depends on, by path", () => {
    // Not decoration: it is why a populated allowlist is now permitted, and the
    // next reader has to be able to find it.
    expect(GATE).toContain("app/privacy/page.tsx");
    expect(GATE).toContain("tests/app/privacy/waitlist-prospect-disclosure.test.ts");
  });

  it("activation still requires an explicit per-studio name in production", () => {
    expect(GATE).toContain("NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS");
    // The convention regex survives as a WARNING signal only (P2-B): it is the
    // shape current writers enforce, not the database's domain.
    expect(GATE).toMatch(/MODERN_WRITER_SLUG_RE/);
    // No bypass, no named exception.
    expect(GATE).not.toMatch(/SKIP_WAITLIST|WAITLIST_BYPASS|ALLOW_DURABLE|FORCE_DURABLE/i);
    expect(GATE.toLowerCase()).not.toContain("willow");
  });
});
