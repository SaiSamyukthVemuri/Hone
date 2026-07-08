import { describe, expect, it, vi } from "vitest";
import {
  shouldAutoSendPostcare,
  autoSendPostcareOnComplete,
} from "@/app/(app)/calendar/postcare-auto-send";

// No real email is ever sent: the pure gate is data-only, and the orchestration
// tests inject a fake admin client + a fake sender.

describe("shouldAutoSendPostcare — eligibility gate", () => {
  const base = {
    deliveryMode: "auto_on_complete",
    status: "completed",
    serviceModality: "electrolysis",
    clientEmail: "c@example.com",
    aftercareText: "Ice the area.",
  };
  it("eligible: auto + completed + non-consultation + email + aftercare", () => {
    expect(shouldAutoSendPostcare(base)).toEqual({ ok: true });
  });
  it("manual (or unset, pre-migration) mode → skipped_mode", () => {
    expect(shouldAutoSendPostcare({ ...base, deliveryMode: "manual" })).toEqual({ ok: false, reason: "skipped_mode" });
    expect(shouldAutoSendPostcare({ ...base, deliveryMode: undefined })).toEqual({ ok: false, reason: "skipped_mode" });
    expect(shouldAutoSendPostcare({ ...base, deliveryMode: null })).toEqual({ ok: false, reason: "skipped_mode" });
  });
  it("cancelled / no_show / not-completed → skipped_not_completed (never auto-sends)", () => {
    for (const status of ["cancelled", "no_show", "confirmed", null, undefined]) {
      expect(shouldAutoSendPostcare({ ...base, status })).toEqual({ ok: false, reason: "skipped_not_completed" });
    }
  });
  it("consultation modality → skipped_consultation (no treatment attestation in auto path)", () => {
    expect(shouldAutoSendPostcare({ ...base, serviceModality: "consultation" })).toEqual({ ok: false, reason: "skipped_consultation" });
  });
  it("no client email → skipped_no_email", () => {
    expect(shouldAutoSendPostcare({ ...base, clientEmail: null })).toEqual({ ok: false, reason: "skipped_no_email" });
    expect(shouldAutoSendPostcare({ ...base, clientEmail: "   " })).toEqual({ ok: false, reason: "skipped_no_email" });
  });
  it("no studio aftercare text → skipped_no_aftercare", () => {
    expect(shouldAutoSendPostcare({ ...base, aftercareText: "" })).toEqual({ ok: false, reason: "skipped_no_aftercare" });
  });
});

// Minimal chainable + thenable fake Supabase admin client. Load chain ends at
// maybeSingle(); the claim update chain ends at select("id"); record-write
// chains end at eq() and are awaited directly.
function fakeAdmin(cfg: { appt: unknown; claimRows: unknown[]; updates: Record<string, unknown>[] }) {
  let pendingClaim = false;
  const b: Record<string, unknown> = {};
  b.from = () => b;
  b.select = () => {
    if (pendingClaim) {
      pendingClaim = false;
      return Promise.resolve({ data: cfg.claimRows, error: null });
    }
    return b;
  };
  b.update = (payload: Record<string, unknown>) => {
    cfg.updates.push(payload);
    // The claim update is the only one that sets send_attempts.
    pendingClaim = payload.postcare_email_send_attempts !== undefined;
    return b;
  };
  b.eq = () => b;
  b.is = () => b;
  b.or = () => b;
  b.maybeSingle = () => Promise.resolve({ data: cfg.appt, error: null });
  b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
  return b as unknown as { from: (t: string) => unknown };
}

const ELIGIBLE_APPT = {
  status: "completed",
  starts_at: "2026-06-03T18:30:00Z",
  postcare_email_sent_at: null,
  postcare_email_send_attempts: 0,
  client: { name: "Client", email: "c@example.com" },
  service: { name: "Electrolysis", modality: "electrolysis" },
  studio: {
    id: "s1",
    name: "Studio",
    owner_email: "o@example.com",
    timezone: "America/Toronto",
    postcare_delivery_mode: "auto_on_complete",
    postcare_aftercare_text: "Ice the area.",
    postcare_warning_signs_text: null,
    postcare_product_recommendations_text: null,
    postcare_review_url: null,
    postcare_review_prompt_text: null,
    postcare_contact_email: null,
  },
  practitioner: { display_name: "Practitioner" },
};

describe("autoSendPostcareOnComplete — orchestration (fail-soft, idempotent)", () => {
  it("NEVER throws (fail-soft) — a db failure returns 'threw', not an exception", async () => {
    const admin = { from: () => { throw new Error("db down"); } };
    await expect(autoSendPostcareOnComplete("a1", "s1", { admin })).resolves.toBe("threw");
  });

  it("manual mode → skipped_mode, no send, no claim update", async () => {
    const send = vi.fn();
    const updates: Record<string, unknown>[] = [];
    const admin = fakeAdmin({
      appt: { ...ELIGIBLE_APPT, studio: { ...ELIGIBLE_APPT.studio, postcare_delivery_mode: "manual" } },
      claimRows: [],
      updates,
    });
    expect(await autoSendPostcareOnComplete("a1", "s1", { admin, sendPostcare: send })).toBe("skipped_mode");
    expect(send).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("eligible + claim won + provider ok → sent; stamps sent_at", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const updates: Record<string, unknown>[] = [];
    const admin = fakeAdmin({ appt: ELIGIBLE_APPT, claimRows: [{ id: "a1" }], updates });
    expect(await autoSendPostcareOnComplete("a1", "s1", { admin, sendPostcare: send })).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
    expect(updates.some((u) => u.postcare_email_sent_at)).toBe(true);
  });

  it("eligible + claim won + provider fails → failed; records failed_at, NOT sent_at", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, retryable: true, error: "boom" });
    const updates: Record<string, unknown>[] = [];
    const admin = fakeAdmin({ appt: ELIGIBLE_APPT, claimRows: [{ id: "a1" }], updates });
    expect(await autoSendPostcareOnComplete("a1", "s1", { admin, sendPostcare: send })).toBe("failed");
    expect(updates.some((u) => u.postcare_email_failed_at)).toBe(true);
    expect(updates.some((u) => u.postcare_email_sent_at)).toBe(false);
  });

  it("claim returns no row (already sent / duplicate completion) → not_claimed, no send", async () => {
    const send = vi.fn();
    const updates: Record<string, unknown>[] = [];
    const admin = fakeAdmin({ appt: ELIGIBLE_APPT, claimRows: [], updates });
    expect(await autoSendPostcareOnComplete("a1", "s1", { admin, sendPostcare: send })).toBe("not_claimed");
    expect(send).not.toHaveBeenCalled();
  });
});
