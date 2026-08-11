import { beforeEach, describe, expect, it, vi } from "vitest";

// 0178 — OPS-ALERT PRACTITIONER ATTRIBUTION, DRIVEN.
//
// Resolving an ops alert is a PLATFORM-GLOBAL operation: there is no target
// studio, so there is no studio to disambiguate a multi-studio admin with. Two
// separate defects lived in that gap and are fixed independently:
//
//   PLURALITY   `.maybeSingle()` did not remove the ambiguity — for an admin
//               with two active memberships it ERRORED, and the discarded error
//               left the id null by accident rather than by rule.
//   FAILURE     a genuine query failure and "no membership" both produced NULL,
//               so the record could not distinguish them.
//
// This drives the REAL action through mocked dependencies for all four cases
// rather than recomputing the rule in the test — recomputation would pass even
// if the action ignored its own resolver.

const state: {
  rows: Array<{ id: string }> | null;
  lookupError: { code: string } | null;
  update: Record<string, unknown> | null;
  updated: boolean;
} = { rows: [], lookupError: null, update: null, updated: false };

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.is = () => q;
      // The practitioner membership lookup resolves here.
      q.then = (r: (v: unknown) => unknown) =>
        r({ data: state.lookupError ? null : state.rows, error: state.lookupError });
      q.update = (payload: Record<string, unknown>) => {
        if (table === "ops_alerts") {
          state.update = payload;
          state.updated = true;
        }
        const done: Record<string, unknown> = {};
        done.eq = () => done;
        done.is = () => done;
        done.then = (r: (v: unknown) => unknown) => r({ error: null });
        return done;
      };
      return q;
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: "admin-user-id", email: "admin@hone.care" } },
      }),
    },
  }),
}));

vi.mock("@/lib/admin", () => ({ isAdmin: () => true }));
vi.mock("@/lib/audit/admin-actions", () => ({ logAdminAction: async () => undefined }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { resolveOpsAlertAction } from "@/app/admin/ops-alerts/actions";

const fd = () => {
  const f = new FormData();
  f.set("alert_id", "11111111-1111-1111-1111-111111111111");
  f.set("resolution_note", "handled");
  return f;
};

describe("0178 — ops-alert attribution is plurality-safe AND failure-explicit", () => {
  beforeEach(() => {
    state.rows = [];
    state.lookupError = null;
    state.update = null;
    state.updated = false;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("EXACTLY ONE active membership is attributed", async () => {
    state.rows = [{ id: "practitioner-1" }];
    await resolveOpsAlertAction(fd());
    expect(state.update?.resolved_by_practitioner_id).toBe("practitioner-1");
  });

  it("ZERO memberships attributes NOBODY — and still resolves the alert", async () => {
    state.rows = [];
    await resolveOpsAlertAction(fd());
    expect(state.update?.resolved_by_practitioner_id).toBeNull();
    expect(state.updated, "attribution is not availability-critical").toBe(true);
  });

  it("TWO memberships attributes NOBODY — ambiguity is not resolved by picking", async () => {
    // The old `.maybeSingle()` threw here; the throw then decided attribution.
    state.rows = [{ id: "practitioner-1" }, { id: "practitioner-2" }];
    await resolveOpsAlertAction(fd());
    expect(state.update?.resolved_by_practitioner_id).toBeNull();
    expect(state.updated).toBe(true);
  });

  it("a LOOKUP FAILURE fails soft to NULL, logs a bounded diagnostic, and still resolves", async () => {
    // The case the previous revision could not express: this is NOT "the admin
    // has no membership", and the record should not imply that it is.
    state.lookupError = { code: "57014" };
    await resolveOpsAlertAction(fd());

    expect(state.update?.resolved_by_practitioner_id).toBeNull();
    expect(state.updated, "a failed attribution lookup must not block resolution").toBe(true);

    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    expect(logged).toContain("ops_alert_resolver_practitioner_lookup_failed");
    expect(logged).toContain("57014");
    // BOUNDED: a stable event name and an error code only — no raw database
    // text, no SQL, no email, no row data.
    expect(logged).not.toMatch(/admin@hone\.care|select |from public\./i);
  });
});
