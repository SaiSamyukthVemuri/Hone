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

// ---------------------------------------------------------------------------
// THE INTERLEAVE SEAM.
//
// closeTreatmentPlanAction obtains its Supabase client TWICE through this
// module: once inside verifyPlanForCurrentStudio (for the verification read),
// then again in the action body AFTER that helper has returned and BEFORE the
// UPDATE is issued. That second call is therefore an exact, already-existing
// interleave point between check and write — no production seam is added for
// the test, and nothing about the action changes.
//
// `run` fires on that second call, so a relationship change it makes is
// guaranteed to land after verification succeeded and before the mutation runs.
//
// Discrimination is by the IMMEDIATE caller frame: getCurrentPractitionerWithStudio
// also reaches createClient, but from lib/supabase/queries.ts, so matching the
// whole stack would miscount. `calls` and `fired` are asserted by the test, so a
// refactor that stops matching turns this RED instead of silently passing.
const interleave = vi.hoisted(() => ({
  armed: false,
  calls: 0,
  fired: 0,
  run: null as null | (() => Promise<void>),
}));

vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createClient: async (...args: unknown[]) => {
      const immediate = (new Error().stack ?? "").split("\n").slice(2)[0] ?? "";
      if (/treatment-plans-actions/.test(immediate)) {
        interleave.calls += 1;
        if (interleave.armed && interleave.calls === 2 && interleave.run) {
          await interleave.run();
          interleave.fired += 1;
        }
      }
      return (actual.createClient as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

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

  // ---------------------------------------- the verification-side predicate
  // P2 4011409205. The ordinary substitution case above proves the close is
  // refused, but not WHICH layer refused it: delete the client check inside
  // verifyPlanForCurrentStudio and it still passes, because the mutation's
  // own `.eq("client_id", clientId)` then matches zero rows and the action
  // fails anyway. Safe either way — but it leaves LAYER A unpinned, and the
  // practitioner silently starts getting the wrong explanation.
  //
  // Two things are pinned here, and they fail for different reasons:
  //
  //   * the EXACT refusal, which only the verification layer produces. The
  //     zero-row path says "That plan changed before it could be closed",
  //     which would be a lie for a pair that was never valid.
  //   * that the refusal happened BEFORE the mutation could be authority.
  //     closeTreatmentPlanAction obtains its own client only after the check
  //     returns ok, so a verification refusal leaves the interleave counter at
  //     ONE. Reaching two means the action walked past the check and was saved
  //     downstream — which is exactly the regression this case exists to catch.
  it("VERIFICATION LAYER: a wrong plan/client pair is refused by the check itself", async () => {
    // A fresh plan owned by CLIENT B, so this case cannot be perturbed by the
    // closures other cases perform.
    const planId = await seedPlan(
      A.studioId,
      A.clientB,
      A.practitionerId,
      "LAYER A PLAN",
    );

    interleave.calls = 0;
    interleave.fired = 0;

    const result = await close(A.clientA, planId);

    // The specific relationship refusal, verbatim. `attachChartEntryToPlanAction`
    // already treats this exact string as a contract when mapping 0167's RPC
    // refusal, so pinning it here matches existing practice rather than
    // inventing a new one.
    expect(result).toEqual({
      ok: false,
      error: "Plan does not belong to this client.",
    });

    // ONE, not two: the action returned at the check and never obtained the
    // client it would have mutated with.
    expect(interleave.calls).toBe(1);

    const after = await planRow(planId);
    expect(after.status).toBe("active");
    expect(after.closed_at).toBeNull();
    expect(revalidated).toEqual([]);
  });

  // ------------------------------------------- the mutation-side predicate
  // P2 4011253879. Every case above is satisfied by the pre-read ALONE: delete
  // `.eq("client_id", clientId)` from the UPDATE and they all still pass,
  // because verifyPlanForCurrentStudio refuses the mismatch before the write is
  // ever reached. That leaves the defence-in-depth binding unpinned — a future
  // refactor could drop it silently.
  //
  // This case separates the two layers. The relationship changes AFTER
  // verification has already succeeded, so the pre-read cannot help: only a
  // mutation that re-binds the client can still refuse. It is deterministic,
  // not a race — the change is injected on the action's own second
  // createClient(), which sits between the check and the write.
  it("TOCTOU: a plan reassigned after verification is not closed for the stale client", async () => {
    const planId = await seedPlan(
      A.studioId,
      A.clientA,
      A.practitionerId,
      "TOCTOU PLAN",
    );

    interleave.calls = 0;
    interleave.fired = 0;
    interleave.armed = true;
    interleave.run = async () => {
      // Hands the plan to CLIENT B while the action holds a verification that
      // said it belonged to CLIENT A.
      await adminQuery(
        `update public.treatment_plans set client_id = $2 where id = $1`,
        [planId, A.clientB],
      );
    };

    let result: ActionResult;
    try {
      result = await close(A.clientA, planId);
    } finally {
      interleave.armed = false;
      interleave.run = null;
    }

    // The seam really fired, and really fired BETWEEN the two calls. Without
    // this the case could pass while injecting nothing at all.
    expect(interleave.calls).toBe(2);
    expect(interleave.fired).toBe(1);

    const after = await planRow(planId);
    expect(after.client_id).toBe(A.clientB); // the reassignment landed

    // WITH the mutation-side predicate the UPDATE matches zero rows.
    // WITHOUT it, (id, studio_id, status='active') still matches and the plan
    // is closed for a client that no longer owns it — which is what makes this
    // case, and only this case, go red when the predicate is removed.
    expect(after.status).toBe("active");
    expect(after.closed_at).toBeNull();
    expect(after.closed_by_practitioner_id).toBeNull();
    expect(result.ok).toBe(false);
    expect(revalidated).toEqual([]);
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
