import { describe, expect, it, vi } from "vitest";
import {
  shouldAutoSendPostcare,
  autoSendPostcareOnComplete,
} from "@/app/(app)/calendar/postcare-auto-send";

// B8 / 0177: the server-resolved practitioner the database authenticates.
const ACTOR = "11111111-2222-3333-4444-555555555555";

// No real email is ever sent: the pure gate is data-only, and the orchestration
// tests inject a fake admin client + a fake sender.

describe("shouldAutoSendPostcare: eligibility gate", () => {
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

// ===========================================================================
// B8 / 0177, ORCHESTRATION against the REAL architecture.
//
// The pre-B8 suite modelled three direct `.update()` chains on `appointments`.
// Those no longer exist: the helper now calls claim_postcare_send, then the
// provider, then settle_postcare_send. Emulating the old chains would have
// tested an architecture the code no longer has, so the fake records an RPC
// TRANSCRIPT and the assertions are about sequencing and arguments.
// ===========================================================================

type RpcCall = { fn: string; args: Record<string, unknown> };

const APPT = "aaaaaaaa-0000-0000-0000-000000000001";
const STUDIO = "bbbbbbbb-0000-0000-0000-000000000002";
/** What the database returns as the claim token: millisecond precision. */
const CLAIM_TOKEN = "2026-08-10T15:04:05.123+00:00";

function eligibleRow() {
  return {
    id: APPT,
    status: "completed",
    starts_at: "2026-08-10T12:00:00.000Z",
    postcare_email_sent_at: null,
    postcare_email_send_attempts: 0,
    client: { name: "Client", email: "c@example.com" },
    service: { name: "Electrolysis", modality: "electrolysis" },
    studio: {
      id: STUDIO,
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
    practitioner: { display_name: "Prac" },
  };
}

/**
 * A fake admin whose ONLY mutation surface is `rpc`. If production code ever
 * reintroduces a direct write, `.update()` is not implemented and the test
 * fails loudly rather than silently passing.
 */
function fakeAdmin(opts: {
  row?: Record<string, unknown> | null;
  claim?: { data?: unknown; error?: unknown };
  settle?: { data?: unknown; error?: unknown };
  calls: RpcCall[];
}) {
  const row = opts.row === undefined ? eligibleRow() : opts.row;
  return {
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: row, error: row ? null : { code: "PGRST116" } });
      q.update = () => {
        throw new Error("B8: production must not write appointments directly");
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      opts.calls.push({ fn, args });
      if (fn === "claim_postcare_send") {
        return (
          opts.claim ?? {
            data: [{ result: "claimed", claimed_at: CLAIM_TOKEN, send_attempts: 1 }],
            error: null,
          }
        );
      }
      return opts.settle ?? { data: [{ result: "settled" }], error: null };
    },
  } as never;
}

const okSender = () => vi.fn(async () => ({ ok: true as const }));
const failSender = (retryable: boolean) =>
  vi.fn(async () => ({ ok: false as const, retryable, error: "provider exploded" }));

describe("autoSendPostcareOnComplete: governed claim/settle orchestration", () => {
  it("AUTO-1/AUTO-2: an ineligible appointment never claims, sends or settles", async () => {
    for (const [label, patch, expected] of [
      ["manual mode", { postcare_delivery_mode: "manual" }, "skipped_mode"],
      ["not completed", null, "skipped_not_completed"],
    ] as const) {
      const calls: RpcCall[] = [];
      const send = okSender();
      const row = eligibleRow();
      if (patch) Object.assign(row.studio, patch);
      else row.status = "confirmed";

      const out = await autoSendPostcareOnComplete(APPT, STUDIO, ACTOR, {
        admin: fakeAdmin({ row, calls }),
        sendPostcare: send as never,
      });

      expect(out, label).toBe(expected);
      expect(calls, `${label}: no RPC`).toHaveLength(0);
      expect(send, `${label}: no provider`).not.toHaveBeenCalled();
    }
  });

  it("AUTO-3/AUTO-11/AUTO-12, claim, provider, settle: sequence, actor and token", async () => {
    const calls: RpcCall[] = [];
    const send = okSender();
    const out = await autoSendPostcareOnComplete(APPT, STUDIO, ACTOR, {
      admin: fakeAdmin({ calls }),
      sendPostcare: send as never,
    });

    expect(out).toBe("sent");
    expect(calls.map((c) => c.fn)).toEqual(["claim_postcare_send", "settle_postcare_send"]);
    expect(send).toHaveBeenCalledTimes(1);

    // AUTO-11: the SERVER-RESOLVED practitioner reaches the database, not a
    // synthetic actor and not the appointment's own practitioner guessed here.
    expect(calls[0].args.p_actor_practitioner_id).toBe(ACTOR);
    expect(calls[0].args.p_is_resend).toBe(false);

    // AUTO-12: the token is forwarded EXACTLY. Re-deriving it through a Date
    // would round microseconds away and settlement would miss its own claim.
    expect(calls[1].args.p_claimed_at).toBe(CLAIM_TOKEN);
    expect(calls[1].args.p_success).toBe(true);
  });

  it("AUTO-4: a lost claim never reaches the provider", async () => {
    const calls: RpcCall[] = [];
    const send = okSender();
    const out = await autoSendPostcareOnComplete(APPT, STUDIO, ACTOR, {
      admin: fakeAdmin({
        calls,
        claim: { data: [{ result: "already_claimed", claimed_at: null }], error: null },
      }),
      sendPostcare: send as never,
    });
    expect(out).toBe("not_claimed");
    expect(send).not.toHaveBeenCalled();
    expect(calls.map((c) => c.fn)).toEqual(["claim_postcare_send"]);
  });

  it("AUTO-5: a MISSING command (old DB) fails soft and never sends", async () => {
    // The app-first deployment window. There is deliberately no direct-UPDATE
    // fallback, so this must end before the provider.
    const calls: RpcCall[] = [];
    const send = okSender();
    const out = await autoSendPostcareOnComplete(APPT, STUDIO, ACTOR, {
      admin: fakeAdmin({
        calls,
        claim: { data: null, error: { code: "PGRST202", message: "not found in schema cache" } },
      }),
      sendPostcare: send as never,
    });
    expect(out).toBe("not_claimed");
    expect(send).not.toHaveBeenCalled();
  });

  it("AUTO-6/AUTO-13: provider failure settled durably reports `failed` and forwards retryable", async () => {
    for (const retryable of [true, false]) {
      const calls: RpcCall[] = [];
      const out = await autoSendPostcareOnComplete(APPT, STUDIO, ACTOR, {
        admin: fakeAdmin({ calls }),
        sendPostcare: failSender(retryable) as never,
      });
      expect(out).toBe("failed");
      expect(calls[1].args.p_success).toBe(false);
      expect(calls[1].args.p_retryable, `retryable=${retryable}`).toBe(retryable);
      expect(calls[1].args.p_claimed_at).toBe(CLAIM_TOKEN);
    }
  });

  it("AUTO-7/AUTO-8: a provider failure that does NOT persist is settle_failed, not failed", async () => {
    for (const settle of [
      { data: null, error: { code: "57014" } },
      { data: [{ result: "stale_claim" }], error: null },
    ]) {
      const calls: RpcCall[] = [];
      const out = await autoSendPostcareOnComplete(APPT, STUDIO, ACTOR, {
        admin: fakeAdmin({ calls, settle }),
        sendPostcare: failSender(true) as never,
      });
      // `failed` would assert a database state that does not exist.
      expect(out).toBe("settle_failed");
    }
  });

  it("AUTO-9/AUTO-10: provider SUCCESS whose settlement does not persist is never `sent`", async () => {
    // The email is out, but Hone has no durable sent_at. Reporting `sent` would
    // be a lie about persisted state; reporting `failed` would be a different
    // lie about the provider.
    for (const settle of [
      { data: null, error: { code: "57014" } },
      { data: [{ result: "stale_claim" }], error: null },
    ]) {
      const calls: RpcCall[] = [];
      const send = okSender();
      const out = await autoSendPostcareOnComplete(APPT, STUDIO, ACTOR, {
        admin: fakeAdmin({ calls, settle }),
        sendPostcare: send as never,
      });
      expect(out).toBe("settle_failed");
      expect(out).not.toBe("sent");
      // Exactly one send: no retry under a different token.
      expect(send).toHaveBeenCalledTimes(1);
      expect(calls.map((c) => c.fn)).toEqual(["claim_postcare_send", "settle_postcare_send"]);
    }
  });

  it("AUTO-14: never throws into appointment completion, whatever the admin does", async () => {
    const exploding = {
      from: () => {
        throw new Error("database on fire");
      },
      rpc: async () => {
        throw new Error("database on fire");
      },
    } as never;
    // The property is that it RESOLVES, a throw here would propagate into
    // mark-complete / start-session and undo an appointment completion because
    // an email helper failed. The exact outcome value matters less than the
    // absence of a throw, so assert both without over-pinning.
    const out = await autoSendPostcareOnComplete(APPT, STUDIO, ACTOR, {
      admin: exploding,
    });
    expect(typeof out).toBe("string");
    expect(out).not.toBe("sent");
  });

  it("production writes appointments ONLY through the commands", async () => {
    // The fake throws on `.update()`, so a reintroduced direct writer surfaces
    // here rather than passing silently.
    const calls: RpcCall[] = [];
    await autoSendPostcareOnComplete(APPT, STUDIO, ACTOR, {
      admin: fakeAdmin({ calls }),
      sendPostcare: okSender() as never,
    });
    expect(calls.every((c) => c.fn.endsWith("_postcare_send"))).toBe(true);
  });
});
