import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "@/e2e/helpers/local-env";
import { adminQuery } from "@/tests/db/helpers/harness";

vi.mock("server-only", () => ({}));

// 0247 compatibility against a REAL database and a real PostgREST. This file is
// phase-agnostic on purpose: it passes on a database WITHOUT 0247 (mode legacy)
// and on one WITH it (mode operation), and fails if the probe ever disagrees with
// what the database actually has, or if the two legacy RPCs and the mode ever
// point different ways. Run it on both sides of 0247 before releasing either.

// supabase-js needs a global WebSocket at construction; Node 20 has none and this test
// opens no realtime channel (the same stub other DB tests use).
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}
const admin = createClient(E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function exists(fn: string): Promise<boolean> {
  const r = await adminQuery(
    "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1",
    [fn],
  );
  return (r.rows[0] as { n: number }).n > 0;
}

async function serviceRoleCanExecute(sig: string): Promise<boolean> {
  const r = await adminQuery("select has_function_privilege('service_role', $1, 'execute') as ok", [sig]);
  return (r.rows[0] as { ok: boolean }).ok;
}

describe("reminder email authority mode on a real database", () => {
  it("the probe agrees with the database, and the legacy RPCs agree with the probe", async () => {
    const { detectReminderAuthorityMode } = await import("@/lib/email/reminder-authority-mode");
    const mode = await detectReminderAuthorityMode(admin);
    const hasOperation = await exists("inspect_appointment_email_operation");
    expect(mode).toBe(hasOperation ? "operation" : "legacy");

    const claim = await serviceRoleCanExecute("public.claim_email_send(uuid,text)");
    const record = await serviceRoleCanExecute("public.record_email_result(uuid,text,boolean)");
    if (mode === "legacy") {
      // Pre-0247: the legacy claim path is the one that works.
      expect(claim, "legacy mode needs claim_email_send callable").toBe(true);
      expect(record, "legacy mode needs record_email_result callable").toBe(true);
    } else {
      // Post-0247: the legacy reminder RPCs are closed and must never be the path.
      expect(claim, "operation mode: claim_email_send must be revoked").toBe(false);
      expect(record, "operation mode: record_email_result must be revoked").toBe(false);
    }
  });

  it("the probe has no effect: no operation, cohort or appointment row is created", async () => {
    const before = await adminQuery("select count(*)::int as n from public.appointments");
    // Measure a delta, not zero: with 0247 applied other DB files in the same
    // run legitimately leave operations behind, and the probe must add none.
    const opsBefore = (await exists("inspect_appointment_email_operation"))
      ? ((await adminQuery("select count(*)::int as n from appointment_email_private.operations")).rows[0] as { n: number }).n
      : null;
    const { detectReminderAuthorityMode } = await import("@/lib/email/reminder-authority-mode");
    await detectReminderAuthorityMode(admin);
    await detectReminderAuthorityMode(admin);
    const after = await adminQuery("select count(*)::int as n from public.appointments");
    expect(after.rows[0]).toEqual(before.rows[0]);
    if (await exists("inspect_appointment_email_operation")) {
      const ops = await adminQuery("select count(*)::int as n from appointment_email_private.operations");
      expect((ops.rows[0] as { n: number }).n).toBe(opsBefore);
    }
  });
});
