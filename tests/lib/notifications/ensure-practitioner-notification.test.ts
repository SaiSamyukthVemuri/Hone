import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensurePractitionerNotification } from "@/lib/notifications/practitioner-notifications";

// Directly testable BECAUSE the durable writer now takes an injected admin
// client. These prove the hardened 23505 handling without a database:
//   * 23505 + a matching (studio_id, dedupe_key) row => idempotent dedupe;
//   * 23505 + NO matching row => a DIFFERENT unique constraint tripped, must
//     NOT be swallowed (throws);
//   * any non-23505 insert error => throws (so the webhook releases the Stripe
//     claim and the event is retried);
//   * clean insert => { deduped: false }.

type FakeOpts = {
  insertError: { code: string; message?: string } | null;
  existingRow: { id: string } | null;
  selectError?: { code: string; message?: string } | null;
};

// Minimal supabase-js shape used by ensurePractitionerNotification:
//   admin.from(t).insert(row)                                  -> { error }
//   admin.from(t).select("id").eq(..).eq(..).maybeSingle()     -> { data, error }
function fakeAdmin(opts: FakeOpts): {
  admin: SupabaseClient;
  inserts: number;
  selects: number;
} {
  const state = { inserts: 0, selects: 0 };
  const selectBuilder = {
    eq() {
      return selectBuilder;
    },
    maybeSingle() {
      return Promise.resolve({
        data: opts.existingRow,
        error: opts.selectError ?? null,
      });
    },
  };
  const builder = {
    insert() {
      state.inserts += 1;
      return Promise.resolve({ error: opts.insertError });
    },
    select() {
      state.selects += 1;
      return selectBuilder;
    },
  };
  const admin = { from: () => builder } as unknown as SupabaseClient;
  return {
    admin,
    get inserts() {
      return state.inserts;
    },
    get selects() {
      return state.selects;
    },
  };
}

const baseInput = {
  studioId: "11111111-1111-1111-1111-111111111111",
  practitionerId: null,
  eventType: "card_added" as const,
  title: "Card added on file",
  body: "Jane added visa ending in 4242.",
  clientId: "22222222-2222-2222-2222-222222222222",
  href: "/clients/22222222-2222-2222-2222-222222222222?tab=overview",
  dedupeKey: "stripe:setup_intent:test:seti_abc",
};

describe("ensurePractitionerNotification: hardened 23505 handling", () => {
  it("clean insert returns { deduped: false } and does NOT run the dedupe check", async () => {
    const f = fakeAdmin({ insertError: null, existingRow: null });
    const r = await ensurePractitionerNotification(f.admin, baseInput);
    expect(r).toEqual({ deduped: false });
    expect(f.inserts).toBe(1);
    expect(f.selects).toBe(0); // no follow-up select on the happy path
  });

  it("23505 WITH a matching dedupe row => { deduped: true } (idempotent)", async () => {
    const f = fakeAdmin({
      insertError: { code: "23505", message: "duplicate key" },
      existingRow: { id: "notif-1" },
    });
    const r = await ensurePractitionerNotification(f.admin, baseInput);
    expect(r).toEqual({ deduped: true });
    expect(f.selects).toBe(1); // verified the row exists before accepting
  });

  it("23505 with NO matching dedupe row => THROWS (unrelated unique constraint, not swallowed)", async () => {
    const f = fakeAdmin({
      insertError: { code: "23505", message: "some other unique" },
      existingRow: null,
    });
    await expect(
      ensurePractitionerNotification(f.admin, baseInput),
    ).rejects.toThrow(/unexpected_unique_violation/);
  });

  it("a non-23505 insert error => THROWS (so the Stripe claim is released and retried)", async () => {
    const f = fakeAdmin({
      insertError: { code: "23503", message: "fk violation" },
      existingRow: null,
    });
    await expect(
      ensurePractitionerNotification(f.admin, baseInput),
    ).rejects.toThrow(/ensure_practitioner_notification_failed:23503/);
  });

  it("a failure of the dedupe-check SELECT => THROWS (does not falsely dedupe)", async () => {
    const f = fakeAdmin({
      insertError: { code: "23505" },
      existingRow: null,
      selectError: { code: "08006", message: "connection failure" },
    });
    await expect(
      ensurePractitionerNotification(f.admin, baseInput),
    ).rejects.toThrow(/dedupe_check_failed:08006/);
  });

  it("an unknown event type => THROWS before any insert", async () => {
    const f = fakeAdmin({ insertError: null, existingRow: null });
    await expect(
      ensurePractitionerNotification(f.admin, {
        ...baseInput,
        // deliberately bypass the compile-time constraint to prove the runtime guard
        eventType: "not_a_real_type" as unknown as typeof baseInput.eventType,
      }),
    ).rejects.toThrow(/unknown event type/);
    expect(f.inserts).toBe(0);
  });
});
