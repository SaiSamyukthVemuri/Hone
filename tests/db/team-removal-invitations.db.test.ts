import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "@/e2e/helpers/local-env";
import { adminQuery, closePool, seedMember, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";

// RBAC G9, the invitation half of removal. A pending invitation is honoured later and can REACTIVATE the person (reconcile_my_pending_invitation
// / admin_accept_pending_invitation), so removing a member must end THIS studio's pending invitation for THAT email, and nothing else.
// Real removePractitionerAction against the real migrated local DB. Only one pending invitation per email can exist across all studios
// (pending_invitations_email_pending_unique), which shapes the scoping cases. Synthetic values only.

const savedEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  stripe: process.env.STRIPE_SECRET_KEY,
};

const SESSION = vi.hoisted(() => ({ current: null as unknown }));
class RedirectSignal extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("@/lib/email/client", () => ({ resend: null, FROM_ADDRESS: "Hone <hello@hone.care>" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: vi.fn(async () => SESSION.current) }));

let removePractitionerAction: (fd: FormData) => Promise<void>;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  ({ removePractitionerAction } = await import("@/app/(app)/settings/team/actions"));
});

afterAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = savedEnv.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.key;
  process.env.STRIPE_SECRET_KEY = savedEnv.stripe;
  await closePool();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

async function emailOf(practitionerId: string): Promise<string> {
  return (await adminQuery("select email from public.practitioners where id = $1", [practitionerId])).rows[0].email as string;
}

async function invite(studioId: string, email: string, status: "pending" | "accepted" | "revoked" = "pending"): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.pending_invitations (id, studio_id, email, role, display_name, status) values ($1,$2,$3,'practitioner','Invited',$4)`,
    [id, studioId, email, status],
  );
  return id;
}

const statusOf = async (id: string): Promise<string> =>
  (await adminQuery("select status from public.pending_invitations where id = $1", [id])).rows[0].status as string;
const activeOf = async (practitionerId: string): Promise<boolean> =>
  (await adminQuery("select active from public.practitioners where id = $1", [practitionerId])).rows[0].active as boolean;

/** Run the real removal as the owner of `ownerOf`'s studio, targeting `memberId`. Returns the redirect url, if any. */
async function remove(ownerOf: SeededStudio, memberId: string): Promise<string | undefined> {
  SESSION.current = {
    practitioner: { id: ownerOf.practitionerId, role: "owner", display_name: "Owner", email: "owner@harness.local" },
    studio: { id: ownerOf.studioId, name: "Studio" },
  };
  const fd = new FormData();
  fd.set("id", memberId);
  try {
    await removePractitionerAction(fd);
    return undefined;
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
}

describe("P2: removal revokes THIS studio's pending invitation for THAT email, and nothing else", () => {
  it("the member's pending invitation becomes revoked; another email's pending invitation and an accepted invitation are unchanged", async () => {
    const A = await seedStudio("invA");
    const m = await seedMember(A, "invM");
    const other = await seedMember(A, "invO");
    const mEmail = await emailOf(m.practitionerId);
    const mInvite = await invite(A.studioId, mEmail);
    const otherPending = await invite(A.studioId, `someone-else-${randomUUID().slice(0, 8)}@harness.local`);
    const acceptedOne = await invite(A.studioId, `accepted-${randomUUID().slice(0, 8)}@harness.local`, "accepted");

    const redirected = await remove(A, m.practitionerId);

    expect(await activeOf(m.practitionerId)).toBe(false);
    expect(await statusOf(mInvite)).toBe("revoked");
    expect(await statusOf(otherPending)).toBe("pending");
    expect(await statusOf(acceptedOne)).toBe("accepted");
    expect(await activeOf(other.practitionerId)).toBe(true);
    expect(redirected ?? "").not.toContain("invitations"); // nothing was left uncleared
  });

  it("the match is on the email case-insensitively as stored, and an already revoked invitation stays revoked", async () => {
    const A = await seedStudio("invC");
    const m = await seedMember(A, "invC");
    const mEmail = await emailOf(m.practitionerId);
    const earlier = await invite(A.studioId, mEmail, "revoked");
    const live = await invite(A.studioId, mEmail.toUpperCase());
    await remove(A, m.practitionerId);
    expect(await statusOf(live)).toBe("revoked");
    expect(await statusOf(earlier)).toBe("revoked");
  });
});

describe("N1: a studio with more pending invitations than the API row cap still has the member's invitation found and revoked", () => {
  it("1,100 other pending invitations in the same studio (above the default PostgREST max-rows of 1,000), the match last in id order, is revoked through the real client", async () => {
    const A = await seedStudio("capA");
    const m = await seedMember(A, "capM");
    const mEmail = await emailOf(m.practitionerId);
    const FILLERS = 1100;
    await adminQuery(
      `insert into public.pending_invitations (id, studio_id, email, role, display_name, status)
       select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, $1, 'cap-filler-' || g || '-' || $2 || '@harness.local', 'practitioner', 'Filler', 'pending'
         from generate_series(1, $3::int) g`,
      [A.studioId, A.studioId.slice(0, 8), FILLERS],
    );
    const matchId = "ffffffff-ffff-4fff-8fff-ffffffffffff"; // sorts after every filler id
    await adminQuery(
      `insert into public.pending_invitations (id, studio_id, email, role, display_name, status) values ($1,$2,$3,'practitioner','Invited','pending')`,
      [matchId, A.studioId, mEmail.toUpperCase()],
    );
    const before = await adminQuery("select count(*)::int as n from public.pending_invitations where studio_id = $1 and status = 'pending'", [A.studioId]);
    expect(before.rows[0].n).toBe(FILLERS + 1); // the rows really are above the cap

    await remove(A, m.practitionerId);

    expect(await statusOf(matchId)).toBe("revoked");
    const stillPending = await adminQuery("select count(*)::int as n from public.pending_invitations where studio_id = $1 and status = 'pending'", [A.studioId]);
    expect(stillPending.rows[0].n).toBe(FILLERS); // every filler untouched
    await adminQuery("delete from public.pending_invitations where studio_id = $1", [A.studioId]);
  });
});

describe("P4: the revoke is scoped by studio, and the studio comes from the session, never from input", () => {
  it("removing the member from A does not touch the same email's pending invitation to studio B", async () => {
    const A = await seedStudio("scA");
    const B = await seedStudio("scB");
    const m = await seedMember(A, "scM");
    const mEmail = await emailOf(m.practitionerId);
    const inB = await invite(B.studioId, mEmail); // only one pending per email can exist, and it is B's
    await remove(A, m.practitionerId);
    expect(await activeOf(m.practitionerId)).toBe(false);
    expect(await statusOf(inB)).toBe("pending");
  });

  it("the owner of B submitting A's member id changes nothing in A: the member stays active and A's pending invitation stays pending", async () => {
    const A = await seedStudio("xsA");
    const B = await seedStudio("xsB");
    const m = await seedMember(A, "xsM");
    const mInvite = await invite(A.studioId, await emailOf(m.practitionerId));
    await expect(remove(B, m.practitionerId)).rejects.toThrow("Practitioner not found in this studio.");
    expect(await activeOf(m.practitionerId)).toBe(true);
    expect(await statusOf(mInvite)).toBe("pending");
  });
});

describe("P3: after removal the revoked invitation cannot bring the person back", () => {
  const reconcile = async (userId: string) =>
    (await userQuery(userId, "select public.reconcile_my_pending_invitation() as r")).rows[0].r as Record<string, unknown>;
  const accept = async (userId: string) =>
    (await adminQuery("select public.admin_accept_pending_invitation($1) as r", [userId])).rows[0].r as Record<string, unknown>;

  it("CONTROL: an inactive member with a still-pending invitation IS offered reactivation (so the test below can see it)", async () => {
    const A = await seedStudio("ctlA");
    const m = await seedMember(A, "ctlM");
    await invite(A.studioId, await emailOf(m.practitionerId));
    await adminQuery("update public.practitioners set active = false where id = $1", [m.practitionerId]); // deactivated WITHOUT the action
    expect((await reconcile(m.userId)).status).toBe("acceptance_required");
  });

  it("removed through the action: reconcile finds no invitation, an explicit accept finds none, and the membership stays inactive", async () => {
    const A = await seedStudio("p3A");
    const m = await seedMember(A, "p3M");
    const mInvite = await invite(A.studioId, await emailOf(m.practitionerId));
    await remove(A, m.practitionerId);

    const r = await reconcile(m.userId);
    expect(r.status).toBe("no_invitation");
    const a = await accept(m.userId);
    expect(a.status).toBe("no_invitation");
    expect(await activeOf(m.practitionerId)).toBe(false);
    expect(await statusOf(mInvite)).toBe("revoked");
    const rows = await adminQuery("select count(*)::int as n from public.practitioners where studio_id = $1 and user_id = $2", [A.studioId, m.userId]);
    expect(rows.rows[0].n).toBe(1); // no duplicate row was created either
  });
});
