import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));

const {
  resolveAdmission,
  newClientMayJoinWaitlist,
  newClientAdmissionIsCutOver,
} = await import("@/lib/booking/new-client-admission");
const { newClientWaitlistCommitIsDurable } = await import(
  "@/lib/booking/new-client-waitlist-durability-bridge"
);
const { NEW_CLIENT_WAITLIST_SLUGS_ENV, NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV } =
  await import("@/lib/booking/new-client-waitlist");

// ===========================================================================
// THE TRANSITION MATRIX — exact-head P1 at b58fc64d.
//
// `waitlist` MEANS durable, and the first version of that law committed
// durably the moment the code deployed. A studio named in the GATE list but
// NOT in the DURABLE list is a supported production configuration whose
// submissions commit by email acceptance today, so the deploy would have moved
// its commit point before anyone chose to - and made the activation document's
// "deploy causes no behaviour change" untrue.
//
// Two facts are therefore needed, not one: WHAT the mode is, and WHETHER the
// studio has actually been cut over to the new authority. A boolean over the
// mode alone cannot express the second, which is why `source` exists.
// ===========================================================================

const SLUG = "a-studio";

function env(gate: string | undefined, durable: string | undefined) {
  if (gate === undefined) delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
  else process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = gate;
  if (durable === undefined)
    delete process.env[NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV];
  else process.env[NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV] = durable;
}

/**
 * The admission the product would resolve for SLUG.
 *
 * `setAt` null means 0204's backfill - nobody has chosen - so the legacy bridge
 * still governs. Non-null means an owner wrote it through the command, which is
 * persisted authority and outranks the env list.
 */
function admission(storedMode: string | null, setAt: string | null = null) {
  return resolveAdmission({
    storedMode,
    storedSetAt: setAt,
    readFailed: false,
    studioSlug: SLUG,
  });
}

const CHOSEN = "2026-09-30T12:00:00.000Z";

const ORIGINAL_GATE = process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
const ORIGINAL_DURABLE = process.env[NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV];

beforeEach(() => env(undefined, undefined));
afterEach(() => env(ORIGINAL_GATE, ORIGINAL_DURABLE));

describe("legacy bridge — the commit point a deploy must not move", () => {
  it("gate OFF / durable OFF: ordinary booking, unchanged", () => {
    env(undefined, undefined);
    const a = admission(null);
    expect(a).toEqual({ ok: true, mode: "open", source: "legacy_bridge" });
    // No join is offered at all, so there is no commit point to move.
    expect(newClientMayJoinWaitlist(a)).toBe(false);
    expect(newClientWaitlistCommitIsDurable(a, SLUG)).toBe(false);
  });

  it("gate ON / durable OFF: the join is permitted and commits by EMAIL, as today", () => {
    env(SLUG, undefined);
    const a = admission(null);
    expect(a).toEqual({ ok: true, mode: "waitlist", source: "legacy_bridge" });
    expect(newClientMayJoinWaitlist(a)).toBe(true);
    // THE WHOLE POINT OF THE BRIDGE. This studio's submissions commit by email
    // acceptance in production today and must keep doing so until its durable
    // mode is actually persisted.
    expect(
      newClientWaitlistCommitIsDurable(a, SLUG),
      "a deploy must not move this studio to the durable path",
    ).toBe(false);
  });

  it("gate ON / durable ON: durable join", () => {
    env(SLUG, SLUG);
    const a = admission(null);
    expect(a).toEqual({ ok: true, mode: "waitlist", source: "legacy_bridge" });
    expect(newClientMayJoinWaitlist(a)).toBe(true);
    expect(newClientWaitlistCommitIsDurable(a, SLUG)).toBe(true);
  });
});

describe("persisted authority — what a cutover actually buys", () => {
  it("persisted WAITLIST is durable whatever the legacy durable list says", () => {
    for (const durable of [undefined, "", "   ", "other-studio", SLUG]) {
      env(SLUG, durable);
      const a = admission("waitlist", CHOSEN);
      expect(a).toEqual({ ok: true, mode: "waitlist", source: "persisted" });
      expect(
        newClientWaitlistCommitIsDurable(a, SLUG),
        `durable list ${JSON.stringify(durable)} must not gate a cut-over studio`,
      ).toBe(true);
    }
  });

  it("persisted CLOSED: no join, and nothing to commit", () => {
    env(SLUG, SLUG);
    const a = admission("closed", CHOSEN);
    expect(a).toEqual({ ok: true, mode: "closed", source: "persisted" });
    expect(newClientMayJoinWaitlist(a)).toBe(false);
    expect(newClientWaitlistCommitIsDurable(a, SLUG)).toBe(false);
  });

  it("UNKNOWN: no join, and nothing to commit", () => {
    env(SLUG, SLUG);
    const a = resolveAdmission({
      storedMode: null,
      storedSetAt: null,
      readFailed: true,
      studioSlug: SLUG,
    });
    expect(a).toEqual({ ok: false });
    expect(newClientMayJoinWaitlist(a)).toBe(false);
    // Fails closed on BOTH questions: an unreadable authority cannot permit a
    // join, and cannot be talked into a commit path either.
    expect(newClientWaitlistCommitIsDurable(a, SLUG)).toBe(false);
  });
});

describe("the migration cannot be faked by editing env", () => {
  it("dropping the durable slug BEFORE cutover is not a completed migration", () => {
    // The trap this matrix exists for. Removing the slug changes the commit
    // point but persists NOTHING, so the studio must still read as not cut
    // over - otherwise "have we finished the migration?" answers yes while no
    // studio row has been written.
    env(SLUG, SLUG);
    const before = admission(null);
    expect(newClientAdmissionIsCutOver(before)).toBe(false);
    expect(newClientWaitlistCommitIsDurable(before, SLUG)).toBe(true);

    env(SLUG, undefined);
    const after = admission(null);
    expect(
      newClientAdmissionIsCutOver(after),
      "an env edit is not a cutover",
    ).toBe(false);
    expect(after.ok && after.source).toBe("legacy_bridge");
    expect(newClientWaitlistCommitIsDurable(after, SLUG)).toBe(false);
  });

  it("after a real cutover, removing legacy durable authority keeps it durable", () => {
    // The inverse, and the reason a boolean over the mode is not enough: these
    // two cases have the SAME mode and the SAME env, and must commit
    // differently. Only provenance separates them.
    env(SLUG, undefined);

    const bridged = admission(null);
    const cutOver = admission("waitlist", CHOSEN);

    expect(bridged.ok && bridged.mode).toBe("waitlist");
    expect(cutOver.ok && cutOver.mode).toBe("waitlist");

    expect(newClientAdmissionIsCutOver(bridged)).toBe(false);
    expect(newClientAdmissionIsCutOver(cutOver)).toBe(true);

    expect(newClientWaitlistCommitIsDurable(bridged, SLUG)).toBe(false);
    expect(
      newClientWaitlistCommitIsDurable(cutOver, SLUG),
      "a cut-over studio must never fall back to email-only",
    ).toBe(true);
  });

  it("the legacy durable list is read from ONE place, so it has a deletion point", async () => {
    const { execSync } = await import("node:child_process");
    // CALL SITES, not mentions. `lib/waitlist/join-profile.ts` names the helper
    // in a doc comment explaining that it adds no second flag system, and a
    // comment cannot read an env var - counting it would make this guard
    // trip on prose.
    const readers = Array.from(
      new Set(
        execSync(
          "git grep -n isNewClientWaitlistDurableEnabled -- 'lib' 'app' || true",
          { cwd: process.cwd() },
        )
          .toString()
          .trim()
          .split("\n")
          .filter(Boolean)
          .filter((line) => {
            const text = line.split(":").slice(2).join(":").trim();
            if (text.startsWith("*") || text.startsWith("//")) return false;
            return text.includes("isNewClientWaitlistDurableEnabled(");
          })
          .map((line) => line.split(":")[0]),
      ),
    ).sort();

    // Declaration plus exactly one consumer. When the bridge file goes, the
    // durable path becomes unconditional - which is what `waitlist` means.
    expect(readers).toEqual([
      "lib/booking/new-client-waitlist-durability-bridge.ts",
      "lib/booking/new-client-waitlist.ts",
    ]);
  });
});
