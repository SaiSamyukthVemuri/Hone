import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  E2E_SERVICE_ROLE_KEY,
  E2E_SUPABASE_URL,
  E2E_WEB_SERVER_ENV,
} from "@/e2e/helpers/local-env";
import { adminQuery, seedStudio } from "@/tests/db/helpers/harness";

// ===========================================================================
// P1 4010957429 — same-studio wrong-client treatment-plan closure
// ===========================================================================
//
// closeTreatmentPlanAction takes BOTH `plan_id` and `client_id` from the
// browser. It validated that each was non-empty, then scoped the UPDATE by
//
//     id = plan_id  AND  studio_id = <server studio>  AND  status = 'active'
//
// and used `client_id` for nothing but `revalidatePath`. Every row involved is
// inside the caller's own tenant, so the studio predicate admits all of them:
// a practitioner on Client A's page could submit Client B's plan id and close
// Client B's active treatment plan.
//
// There is no database backstop for this. `treatment_plans` RLS is
// studio-scoped only, the table carries no triggers, and `authenticated` holds
// direct UPDATE. The application predicate was the only control.
//
// The repository already had the right seam two functions below the defect —
// `verifyPlanForCurrentStudio(planId, clientId, requireActive)`, which refuses
// `plan.client_id !== clientId`. Every stage-mutating action and the notes
// action used it. The close action did not.
//
// This file drives the REAL server action against the REAL database as a REAL
// authenticated practitioner (a genuine GoTrue session whose cookie is handed
// to the action's own `createClient()`), so RLS is in force exactly as in
// production. A source-shape assertion could not prove any of this.
// ===========================================================================

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));

// revalidatePath needs a Next request store. Recording the calls also lets the
// suite assert the CACHE consequence of a refusal, which is the other half of
// "the submitted client id is not authority": a refused close must not
// revalidate the attacker-named client either.
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => {
    revalidated.push(p);
  },
  revalidateTag: () => {},
}));

type ActionResult = { ok: true } | { ok: false; error: string };
type CloseAction = (fd: FormData) => Promise<ActionResult>;

let closeTreatmentPlanAction: CloseAction;

const A = { studioId: "", practitionerId: "", clientA: "", clientB: "", planA: "", planB: "" };
const FOREIGN = { studioId: "", clientId: "", planId: "" };

async function seedPlan(studioId: string, clientId: string, practitionerId: string, name: string) {
  const id = randomUUID();
  await adminQuery(
    `insert into public.treatment_plans
       (id, studio_id, client_id, name, status, created_by_practitioner_id)
     values ($1, $2, $3, $4, 'active', $5)`,
    [id, studioId, clientId, name, practitionerId],
  );
  return id;
}

async function planRow(id: string) {
  const { rows } = await adminQuery(
    // closed_at as TEXT: node-postgres hands back a Date, and two Dates with
    // the same instant are not identical, so an unchanged-timestamp assertion
    // would fail on object identity rather than on a re-stamp.
    `select status, closed_at::text as closed_at, closed_by_practitioner_id, client_id
       from public.treatment_plans where id = $1`,
    [id],
  );
  return rows[0] as {
    status: string;
    closed_at: string | null;
    closed_by_practitioner_id: string | null;
    client_id: string;
  };
}

function close(clientId: string, planId: string): Promise<ActionResult> {
  const fd = new FormData();
  fd.set("client_id", clientId);
  fd.set("plan_id", planId);
  return closeTreatmentPlanAction(fd);
}

describe("closeTreatmentPlanAction — object authority", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;

    const seed = await seedStudio(`planidor-${randomUUID().slice(0, 6)}`);
    A.studioId = seed.studioId;
    A.practitionerId = seed.practitionerId;
    A.clientA = seed.clientId;

    // A SECOND client in the SAME studio. This is the whole point: both
    // clients are legitimately visible to this practitioner, so RLS cannot
    // separate them.
    A.clientB = randomUUID();
    await adminQuery(
      `insert into public.clients (id, studio_id, name) values ($1, $2, 'CLIENT B (same studio)')`,
      [A.clientB, A.studioId],
    );

    A.planA = await seedPlan(A.studioId, A.clientA, A.practitionerId, "PLAN A");
    A.planB = await seedPlan(A.studioId, A.clientB, A.practitionerId, "PLAN B");

    // A genuinely foreign tenant, for the cross-studio control.
    const other = await seedStudio(`planidor-x-${randomUUID().slice(0, 6)}`);
    FOREIGN.studioId = other.studioId;
    FOREIGN.clientId = other.clientId;
    FOREIGN.planId = await seedPlan(
      other.studioId,
      other.clientId,
      other.practitionerId,
      "FOREIGN PLAN",
    );

    // A REAL signed-in practitioner of studio A. The action's own
    // createClient() reads this cookie, so every query runs under real RLS.
    const email = `planidor-${randomUUID().slice(0, 8)}@harness.local`;
    const password = `Pw-${randomUUID()}`;
    const created = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: E2E_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (!created.ok) throw new Error(`local GoTrue createUser failed: ${created.status}`);
    const authUser = (await created.json()) as { id: string };
    await adminQuery(
      "update public.practitioners set user_id = $2, email = $3 where id = $1",
      [A.practitionerId, authUser.id, email],
    );

    const token = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!token.ok) throw new Error(`local sign-in failed: ${token.status}`);
    const session = (await token.json()) as { access_token: string; refresh_token: string };

    const writer = createServerClient(E2E_SUPABASE_URL, ANON, {
      cookies: {
        getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
        setAll: (list: Array<{ name: string; value: string }>) =>
          list.forEach(({ name, value }) => jar.set(name, value)),
      },
    });
    await writer.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (jar.size === 0) throw new Error("no auth cookie was written");

    closeTreatmentPlanAction = (
      await import("@/app/(app)/clients/[id]/treatment-plans-actions")
    ).closeTreatmentPlanAction as CloseAction;
  }, 120_000);

  beforeEach(() => {
    revalidated.length = 0;
  });

  // ------------------------------------------------------------------ fixture
  it("fixture: the two plans belong to DIFFERENT clients of the SAME studio", async () => {
    const a = await planRow(A.planA);
    const b = await planRow(A.planB);
    expect(a.client_id).toBe(A.clientA);
    expect(b.client_id).toBe(A.clientB);
    expect(a.status).toBe("active");
    expect(b.status).toBe("active");
    // Both are inside the caller's own studio, so this is NOT a cross-tenant
    // case and RLS is not the control under test.
    const { rows } = await adminQuery(
      `select count(*)::int c from public.treatment_plans
        where id = any($1::uuid[]) and studio_id = $2`,
      [[A.planA, A.planB], A.studioId],
    );
    expect(rows[0].c).toBe(2);
    // CLIENT A owns no plan with PLAN B's id — the attack cannot be excused as
    // "the practitioner closed a plan the route client actually owned".
    const owned = await adminQuery(
      `select count(*)::int c from public.treatment_plans where id = $1 and client_id = $2`,
      [A.planB, A.clientA],
    );
    expect(owned.rows[0].c).toBe(0);
  });

  // ------------------------------------------------------------- THE DEFECT
  it("SAME-STUDIO WRONG-CLIENT: client A's form must not close client B's plan", async () => {
    const result = await close(A.clientA, A.planB);
    const after = await planRow(A.planB);

    // The security assertion. Against the vulnerable implementation this is
    // what goes red: the plan is closed and the action reports ok.
    expect(after.status).toBe("active");
    expect(after.closed_at).toBeNull();
    expect(after.closed_by_practitioner_id).toBeNull();
    expect(result.ok).toBe(false);
  });

  it("a refused close revalidates nothing — the submitted client id is not authority", async () => {
    revalidated.length = 0;
    const result = await close(A.clientA, A.planB);
    expect(result.ok).toBe(false);
    expect(revalidated).toEqual([]);
  });

  // ---------------------------------------------------------- cross-tenant
  it("CROSS-STUDIO: a foreign studio's plan is refused with zero mutation", async () => {
    const result = await close(A.clientA, FOREIGN.planId);
    const after = await planRow(FOREIGN.planId);
    expect(result.ok).toBe(false);
    expect(after.status).toBe("active");
    expect(after.closed_at).toBeNull();
  });

  it("NONEXISTENT: a random plan id fails truthfully and mutates nothing", async () => {
    const before = await adminQuery(
      `select count(*)::int c from public.treatment_plans where status = 'closed'`,
    );
    const result = await close(A.clientA, randomUUID());
    const after = await adminQuery(
      `select count(*)::int c from public.treatment_plans where status = 'closed'`,
    );
    expect(result.ok).toBe(false);
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  // ------------------------------------------------------- positive control
  // Without this, every assertion above is satisfied by an action that refuses
  // everything.
  it("POSITIVE: client A's own active plan closes, exactly once, with attribution", async () => {
    const result = await close(A.clientA, A.planA);
    expect(result.ok).toBe(true);

    const after = await planRow(A.planA);
    expect(after.status).toBe("closed");
    expect(after.closed_at).not.toBeNull();
    expect(after.closed_by_practitioner_id).toBe(A.practitionerId);
    expect(revalidated).toContain(`/clients/${A.clientA}`);
    expect(revalidated).toContain(`/clients/${A.clientA}/sessions`);
  });

  it("ALREADY CLOSED: a second close does not report a fresh successful closure", async () => {
    const first = await planRow(A.planA);
    expect(first.status).toBe("closed"); // ordering guard for the case above

    const result = await close(A.clientA, A.planA);
    expect(result.ok).toBe(false);

    // And the original closure record is untouched — not re-stamped.
    const after = await planRow(A.planA);
    expect(after.closed_at).toBe(first.closed_at);
    expect(after.closed_by_practitioner_id).toBe(first.closed_by_practitioner_id);
  });

  // -------------------------------------------------- neighbouring behaviour
  it("client B's plan is STILL closable by client B's own form", async () => {
    // The repair must refuse the wrong parent, not break the right one.
    const result = await close(A.clientB, A.planB);
    expect(result.ok).toBe(true);
    const after = await planRow(A.planB);
    expect(after.status).toBe("closed");
    expect(after.client_id).toBe(A.clientB);
  });
});
