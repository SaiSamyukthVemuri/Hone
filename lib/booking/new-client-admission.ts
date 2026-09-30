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
export type NewClientAdmission =
  | { ok: true; mode: NewClientAdmissionMode }
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
  if (input.storedMode == null) {
    return { ok: true, mode: envWaitlist ? "waitlist" : "open" };
  }

  // Stored `closed` and `waitlist` are the owner's own decision and stand as
  // written. Only `open` is subject to the one-way bridge above.
  if (input.storedMode === "open" && envWaitlist) {
    return { ok: true, mode: "waitlist" };
  }
  return { ok: true, mode: input.storedMode };
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
      .select("new_client_admission_mode")
      .eq("id", studio.id)
      .maybeSingle();
    if (error) {
      // MIGRATION-ORDER SAFETY. Before 0204 applies, the column does not exist
      // and the deployed app must still work: that is skew, not an outage, so
      // it falls through to the env rather than reporting unknown.
      if (isMissingColumn(error)) {
        storedMode = null;
      } else {
        readFailed = true;
      }
    } else {
      storedMode =
        (data as { new_client_admission_mode?: string | null } | null)
          ?.new_client_admission_mode ?? null;
    }
  } catch {
    readFailed = true;
  }
  return resolveAdmission({ storedMode, readFailed, studioSlug: studio.slug });
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

/**
 * Is this studio in WAITLIST mode?
 *
 * For callers that need the fact as a plain boolean - the free-consult
 * reschedule policy is pure and cannot perform this read itself.
 *
 * UNKNOWN maps to `false`, which is deliberate and narrow: these callers are
 * deciding whether an EXTRA restriction applies to an existing client's
 * reschedule, so an unreadable mode must not invent one. That is the same
 * answer the default-off env behaviour gave an unconfigured deployment, and it
 * is the opposite of the fail-closed rule for NEW-client mutation, where
 * `unknown` refuses.
 */
export async function studioIsInWaitlistMode(
  studio: { id?: string | null; slug?: string | null } | null | undefined,
): Promise<boolean> {
  if (!studio?.id) return false;
  const a = await getNewClientAdmissionMode({
    id: studio.id,
    slug: studio.slug ?? null,
  });
  return a.ok && a.mode === "waitlist";
}
