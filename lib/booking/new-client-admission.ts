import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isNewClientWaitlistEnabled } from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// NEW-CLIENT-MODE-01 — THE ONE ADMISSION AUTHORITY
// ===========================================================================
//
// Every studio owns exactly one NEW-CLIENT admission mode, and exactly one
// module answers what it is. Before this, the answer was assembled from a
// server-only env list at seven call sites — the public page, the booking
// action, the waitlist action, the settings nav, the free-consult reschedule
// policy and readiness — each free to read it slightly differently, and none of
// them changeable by the owner whose studio it governs.
//
// NEW-CLIENT ONLY, AND THAT IS THE WHOLE SCOPE. Nothing here may be consulted
// to decide what an EXISTING client may do. Their booking, portal access and
// rebooking are outside this authority in all three modes, and no consumer of
// this module sits on those paths.
//
// THE FOUR ANSWERS:
//
//   open      new clients book normally.
//   waitlist  new clients cannot book; the durable waitlist form is offered,
//             and a successful join ALWAYS writes new_client_waitlist_entries.
//   closed    new clients cannot book and cannot join a waitlist; the public
//             page says so truthfully.
//   unknown   the authority could not be read.
//
// UNKNOWN IS NOT OPEN. A failed read must never reopen a studio that an owner
// closed or waitlisted — that would turn an outage into a product decision
// nobody made. Every NEW-client mutation treats `unknown` as refusal, and every
// surface renders it as "we could not check", never as an open door.
// ===========================================================================

export type NewClientAdmissionMode = "open" | "waitlist" | "closed";
/**
 * WHERE the effective mode came from. NOT a second mode, and NOT a policy.
 *
 * `waitlist` can be reached two ways, and during the migration they are not the
 * same fact:
 *
 *   persisted      the stored `studios.new_client_admission_mode` column
 *                  decided this. The studio HAS been cut over.
 *   legacy_bridge  NEW_CLIENT_WAITLIST_STUDIO_SLUGS decided it - either because
 *                  nothing is stored yet, or because it overrode a stored
 *                  `open`. The studio has NOT been cut over.
 *
 * Collapsing the two would make the transition unprovable: a studio riding the
 * bridge is indistinguishable from a migrated one, so "did we finish the
 * migration?" has no answer, and dropping a slug from the legacy DURABLE list
 * would read as a completed cutover when nothing had been persisted at all.
 *
 * MIGRATION-ONLY DISTINCTION. After cutover every studio answers `persisted`,
 * `legacy_bridge` becomes unreachable, and this field and its one consumer -
 * lib/booking/new-client-waitlist-durability-bridge.ts - are deleted together.
 */
export type NewClientAdmissionSource = "persisted" | "legacy_bridge";

export type NewClientAdmission =
  | { ok: true; mode: NewClientAdmissionMode; source: NewClientAdmissionSource }
  | { ok: false };

/** The closed set, as the database defines it. */
export const NEW_CLIENT_ADMISSION_MODES: readonly NewClientAdmissionMode[] = [
  "open",
  "waitlist",
  "closed",
] as const;

export function isNewClientAdmissionMode(
  v: unknown,
): v is NewClientAdmissionMode {
  return (
    typeof v === "string" &&
    (NEW_CLIENT_ADMISSION_MODES as readonly string[]).includes(v)
  );
}

/**
 * The TRANSITION BRIDGE, and the exact shape of its temporariness.
 *
 * `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` is still the live authority in production
 * until the activation gate writes each studio's real mode. Until then the env
 * may only ESCALATE a studio to `waitlist`; it can never move one to `open`.
 *
 * That direction is the whole safety property. If the env could de-escalate, a
 * deploy that dropped a slug would silently reopen a studio the owner had
 * waitlisted — and, worse, would move its submissions off the durable path.
 * One-way escalation means the worst a stale env can do is keep a studio on a
 * waitlist it already had.
 *
 * REMOVING THIS IS THE LAST STEP OF THE CUTOVER, not part of this PR: delete
 * this function, its call in `resolveAdmission`, and only then the env vars.
 */
function envForcesWaitlist(studioSlug: string | null | undefined): boolean {
  return isNewClientWaitlistEnabled(studioSlug);
}

/** Pure resolution, so every state below is reachable in a unit test. */
export function resolveAdmission(input: {
  /** The stored column, or null when the row predates 0204. */
  storedMode: string | null | undefined;
  /**
   * `new_client_admission_mode_set_at`: the audit fact that separates an
   * INITIALIZED persisted authority from a row that never had one.
   *
   * 0204 adds the mode column as `not null default 'open'`, so every
   * pre-existing row reads `open` the moment it applies - and nobody chose
   * that. NON-NULL means the persisted authority IS initialized; NULL means it
   * never was, and that row is a pre-0204 legacy row. Without the distinction
   * the two are indistinguishable, which is how an owner could press "Accept
   * bookings", be told it saved, and stay waitlisted until operations edited an
   * env var.
   *
   * NON-NULL NO LONGER IMPLIES AN OWNER CHOSE. Since 0205 the column carries a
   * `now()` default, so a studio is born stamped and system-initialized at
   * `open` - which is the whole point: a brand-new studio is NOT a legacy row
   * and must not inherit the cutover ceremony. There are therefore two writers,
   * not one: this default at INSERT, and `set_new_client_admission_mode` on
   * every owner change. `new_client_admission_mode_set_by` is what tells them
   * apart - NULL for system initialization, the resolved practitioner for an
   * owner's change - and it is NULL at creation because no practitioner row FOR
   * THIS STUDIO exists when the studio is inserted. No trigger provisions one -
   * 0141 made `handle_new_user()` a NO-OP - and the membership is created or
   * reconciled only later, at authenticated sign-in or explicit invitation
   * acceptance, through 0141's reconciliation path, keyed to a studio_id that
   * does not exist until that INSERT. Deliberately NOT "the owner has no Auth
   * account yet": 0141 reconciles existing accounts too, so an invited owner may
   * already be signed up and hold practitioner rows in other studios.
   *
   * Nothing here reads `set_by`: "initialized or not" is the only question this
   * resolution asks, and both initialized states answer it the same way.
   */
  storedSetAt: string | null | undefined;
  /** True when the studio row itself could not be read. */
  readFailed: boolean;
  /** Server-resolved slug, never browser-supplied. */
  studioSlug: string | null | undefined;
}): NewClientAdmission {
  // A failed read is not a mode. It is the absence of one.
  if (input.readFailed) return { ok: false };

  const envWaitlist = envForcesWaitlist(input.studioSlug);

  // A stored value outside the closed set cannot be interpreted. The database
  // CHECK makes it unreachable, so reaching it means the model moved underneath
  // us — which is precisely when guessing is worst.
  if (input.storedMode != null && !isNewClientAdmissionMode(input.storedMode)) {
    return { ok: false };
  }

  // No stored value: the row predates 0204, so the env is all there is.
  // Nothing stored decides anything: whatever this is, the studio has not been
  // cut over, and `open` here is a default rather than an owner's choice.
  if (input.storedMode == null) {
    return {
      ok: true,
      mode: envWaitlist ? "waitlist" : "open",
      source: "legacy_bridge",
    };
  }

  // AN EXPLICIT OWNER WRITE IS AUTHORITATIVE, IMMEDIATELY, INCLUDING `open`.
  //
  // The env bridge exists to preserve behaviour for studios that have NOT yet
  // chosen. The first deliberate write through the command cuts that studio over,
  // and from then on the legacy list cannot move it - so an owner who selects
  // "Accept bookings" becomes OPEN even while their slug is still listed, and
  // `closed` -> `open` really does reopen booking rather than reopening to a
  // waitlist.
  //
  // This is also what makes the save TRUTHFUL: the settings action reports
  // success on the command's `ok`, and the bridge must not then refuse the choice
  // it just confirmed.
  if (input.storedSetAt != null) {
    return { ok: true, mode: input.storedMode, source: "persisted" };
  }

  // NEVER INITIALIZED. `set_at` is null, so this is a pre-0204 row carrying
  // 0204's backfill default - not a decision, and not a studio created since
  // 0205 (those are born stamped and took the `persisted` branch above).
  // The bridge still governs, and it is ONE-WAY: it may escalate an unchosen
  // `open` to waitlist, and it may never de-escalate anything.
  if (input.storedMode === "open" && envWaitlist) {
    return { ok: true, mode: "waitlist", source: "legacy_bridge" };
  }
  return { ok: true, mode: input.storedMode, source: "legacy_bridge" };
}

/**
 * Read a studio's admission mode.
 *
 * The caller passes a SERVER-RESOLVED studio (id and slug read back off the
 * studios row), never anything a browser sent, so a forged form cannot choose
 * whose configuration is consulted.
 */
export async function getNewClientAdmissionMode(studio: {
  id: string;
  slug: string | null;
}): Promise<NewClientAdmission> {
  let storedMode: string | null = null;
  let storedSetAt: string | null = null;
  let readFailed = false;
  try {
    // A SERVER-ONLY PRIVILEGED READ, AND IT HAS TO BE.
    //
    // `studios` RLS is "members read" for `authenticated` only, so the
    // RLS-scoped client returns NO ROW for a public visitor - and `maybeSingle`
    // reports that as `{ data: null, error: null }`. Read through that client,
    // a stored WAITLIST or CLOSED became `storedMode = null`, fell through to
    // the legacy bridge, and a studio the owner had paused or closed silently
    // went on taking bookings. Silent, because nothing errored.
    //
    // The public booking page already reads this row the same way
    // (`getStudioBySlug` uses the admin client for exactly this reason). The
    // narrowing that keeps it safe is the projection and the key: ONE column,
    // by the SERVER-RESOLVED studio id. No policy is added, `studios` is not
    // made publicly readable, and no other column is exposed.
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("studios")
      // TWO columns, and the second is not decoration: `set_at` is the only
      // thing that separates an owner's deliberate `open` from 0204's
      // backfilled default, and the legacy bridge may escalate one but not the
      // other. Still narrowly scoped - no other studio column is read.
      .select("new_client_admission_mode, new_client_admission_mode_set_at")
      .eq("id", studio.id)
      .maybeSingle();
    if (error) {
      // MIGRATION-ORDER SAFETY. Before 0204 applies, the column does not exist
      // and the deployed app must still work: that is skew, not an outage, so
      // it falls through to the env rather than reporting unknown.
      if (isMissingColumn(error)) {
        storedMode = null;
        storedSetAt = null;
      } else {
        readFailed = true;
      }
    } else {
      const row = data as {
        new_client_admission_mode?: string | null;
        new_client_admission_mode_set_at?: string | null;
      } | null;
      if (row == null) {
        // NO ROW IS NOT A MODE. `maybeSingle()` reports "nothing matched" as
        // `{ data: null, error: null }`, so a studio deleted between the
        // caller's lookup and this read arrives here as a SUCCESS with no row.
        //
        // Optional chaining used to turn that into the same `(null, null)` the
        // pre-0204 MISSING COLUMN path uses, and the bridge then answered with
        // full confidence - `open`, or `waitlist` if the slug happened to be
        // listed. That is the same silent-null defect this module was created to
        // fix, in a second place: migration skew and a vanished studio are not
        // the same fact and must not share a representation.
        //
        // The bridge fallback is now reserved for the EXPLICIT missing-column
        // error, and everything else fails closed.
        readFailed = true;
      } else {
        storedMode = row.new_client_admission_mode ?? null;
        storedSetAt = row.new_client_admission_mode_set_at ?? null;
      }
    }
  } catch {
    readFailed = true;
  }
  return resolveAdmission({
    storedMode,
    storedSetAt,
    readFailed,
    studioSlug: studio.slug,
  });
}

function isMissingColumn(error: { code?: string; message?: string }): boolean {
  // 42703 is undefined_column. The message check covers PostgREST's own
  // schema-cache phrasing, which does not always carry the SQLSTATE.
  return (
    error?.code === "42703" ||
    /new_client_admission_mode/i.test(error?.message ?? "")
  );
}

/**
 * May a NEW client book normally right now?
 *
 * The single predicate every new-client booking path asks. `unknown` is false
 * here, and deliberately so.
 */
/**
 * Refusal for a NEW-client booking under `closed` or an UNREADABLE mode.
 *
 * ONE message and ONE code for both, deliberately. `closed` and `unknown`
 * differ in cause and not in consequence - neither admits a new client - and a
 * distinct answer for `unknown` would publish the fact that a read failed. It
 * also must NOT say "join the waitlist": under `closed` there is no waitlist to
 * join, and under `unknown` we cannot claim there is.
 *
 * It is returned whether or not invitation credentials were presented, so it
 * cannot be used to probe whether an invitation is valid.
 */
export const NEW_CLIENT_ADMISSION_REFUSAL_CODE = "new_client_admission_closed" as const;
export const NEW_CLIENT_ADMISSION_CLOSED_REFUSAL =
  "This studio is not accepting new-client bookings right now.";

/**
 * Does admission refuse a NEW client OUTRIGHT - with no invitation exception?
 *
 * TRUE for `closed` and for an unreadable mode; FALSE for `open` and
 * `waitlist`. `waitlist` refuses the ORDINARY path but is the one mode where a
 * valid scoped invitation may still authorise a booking, which is the WAIT
 * invitation lifecycle. `closed` and `unknown` admit no one: a previously
 * issued invitation must not override a studio the owner closed, and a failed
 * read must not be recoverable by presenting credentials.
 */
/**
 * Has this studio's admission actually been CUT OVER to the new authority?
 *
 * TRUE only when the stored column decided the mode. It is deliberately a
 * question about PROVENANCE, not about the mode: a studio on the legacy bridge
 * answers `false` whether or not it is in either env list, so removing a slug
 * from the legacy durable list can never be mistaken for a completed
 * migration. That list is named in exactly one place - see
 * lib/booking/new-client-waitlist-durability-bridge.ts - and this module
 * deliberately does not name it.
 *
 * MIGRATION-ONLY. Deleted with the bridge.
 */
/**
 * The ONE server-derived transition fact a database command may be handed.
 *
 * 0204 cannot read Vercel env state, so for an UNSTAMPED row the database cannot
 * know whether the legacy list escalates it. This supplies that single boolean,
 * from the SERVER-RESOLVED slug - never anything a browser sent.
 *
 * It is consulted inside the locked transaction ONLY when
 * `new_client_admission_mode_set_at IS NULL`. A stamped row ignores it.
 *
 * TEMPORARY. Retired with the bridge at cutover, together with the commands'
 * `p_legacy_bridge_waitlist` argument. See
 * docs/production/new-client-admission-activation.md, step H.
 */
export function newClientAdmissionLegacyBridgeWaitlist(
  studioSlug: string | null | undefined,
): boolean {
  return envForcesWaitlist(studioSlug);
}

export function newClientAdmissionIsCutOver(a: NewClientAdmission): boolean {
  return a.ok && a.source === "persisted";
}

export function newClientAdmissionRefusesOutright(
  a: NewClientAdmission,
): boolean {
  return !a.ok || a.mode === "closed";
}

export function newClientMayBook(a: NewClientAdmission): boolean {
  return a.ok && a.mode === "open";
}

/**
 * May a NEW client join the waitlist right now?
 *
 * True ONLY in waitlist mode. `closed` refuses the join as well as the booking,
 * which is the difference between the two refusals.
 */
export function newClientMayJoinWaitlist(a: NewClientAdmission): boolean {
  return a.ok && a.mode === "waitlist";
}


// The two PUBLIC SURFACE functions live in a client-safe module, because
// `app/book/[slug]/PublicBookForm.tsx` is a client component and this module is
// `server-only`. Re-exported here so server callers and tests keep importing
// them from the canonical place. See new-client-admission-surface.ts.
export {
  publicNewClientSurface,
  publicBookFormSurface,
} from "@/lib/booking/new-client-admission-surface";
export type {
  PublicNewClientSurface,
  PublicBookFormSurface,
} from "@/lib/booking/new-client-admission-surface";
