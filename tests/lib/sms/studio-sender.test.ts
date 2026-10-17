import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveStudioSmsSender,
  studioSenderAllowsSend,
} from "@/lib/sms/studio-sender";

// ===========================================================================
// WAIT S3 — the studio's own sending identity, or nothing
//
// No provider, no network, no send. The RPC is stubbed, because what is under
// test is the REFUSAL DISCIPLINE: every path that cannot produce the studio's
// own identity must refuse, and none may fall back to a platform sender.
// ===========================================================================

const STUDIO = "11111111-1111-4111-8111-111111111111";
const SID = "MG0123456789abcdef0123456789abcdef";

/** Minimal stub: only `.rpc` is exercised. */
function client(rpc: ReturnType<typeof vi.fn>): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

function returning(data: unknown, error: unknown = null) {
  return vi.fn().mockResolvedValue({ data, error });
}

describe("the happy path resolves the STUDIO's own identity", () => {
  it("returns the active sender's messaging service", async () => {
    const rpc = returning([{ messaging_service_sid: SID }]);
    const r = await resolveStudioSmsSender(client(rpc), STUDIO);
    expect(r).toEqual({ ok: true, messagingServiceSid: SID });
  });

  it("asks 0194's command, not the table", async () => {
    // 0191 revoked ALL on studio_sms_senders from service_role, so a direct
    // select could never work. The command is the only route.
    const rpc = returning([{ messaging_service_sid: SID }]);
    await resolveStudioSmsSender(client(rpc), STUDIO);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("resolve_active_studio_sms_sender", {
      p_studio_id: STUDIO,
    });
  });

  it("passes the studio through unchanged — no defaulting, no widening", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const rpc = returning([{ messaging_service_sid: SID }]);
    await resolveStudioSmsSender(client(rpc), other);
    expect(rpc.mock.calls[0]![1]).toEqual({ p_studio_id: other });
  });
});

describe("NO ACTIVE SENDER is a configuration fact, not an error", () => {
  it("refuses with no_active_sender on zero rows", async () => {
    const rpc = returning([]);
    const r = await resolveStudioSmsSender(client(rpc), STUDIO);
    expect(r).toEqual({ ok: false, reason: "no_active_sender" });
  });

  it("does not report it as a read failure", async () => {
    // A studio mid-provisioning has not broken anything; conflating the two
    // would send an operator chasing an outage that does not exist.
    const rpc = returning([]);
    const r = await resolveStudioSmsSender(client(rpc), STUDIO);
    expect(r.ok === false && r.reason).not.toBe("read_failed");
  });
});

describe("AMBIGUITY is refused, never resolved by guessing", () => {
  it("refuses when two senders are active", async () => {
    // 0194 returns a SET deliberately: one live row per studio is guaranteed by
    // studio_sms_senders_one_live_per_studio, so two rows is a VIOLATED
    // INVARIANT that must surface, not be silently narrowed.
    const rpc = returning([
      { messaging_service_sid: SID },
      { messaging_service_sid: "MGffffffffffffffffffffffffffffffff" },
    ]);
    const r = await resolveStudioSmsSender(client(rpc), STUDIO);
    expect(r).toEqual({ ok: false, reason: "ambiguous_active_sender" });
  });

  it("NEVER picks the first row", async () => {
    const rpc = returning([
      { messaging_service_sid: SID },
      { messaging_service_sid: "MGffffffffffffffffffffffffffffffff" },
    ]);
    const r = await resolveStudioSmsSender(client(rpc), STUDIO);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SID);
  });
});

describe("unreadable answers fail closed", () => {
  it("refuses on an RPC error", async () => {
    const rpc = returning(null, { message: "boom" });
    const r = await resolveStudioSmsSender(client(rpc), STUDIO);
    expect(r).toEqual({ ok: false, reason: "read_failed" });
  });

  it("refuses a non-array shape rather than reading it as 'no sender'", async () => {
    // The dangerous misreading: an unrecognised shape treated as zero rows
    // looks like an ordinary un-provisioned studio.
    for (const shape of [null, undefined, {}, "MG123", 0]) {
      const r = await resolveStudioSmsSender(client(returning(shape)), STUDIO);
      expect(r, JSON.stringify(shape)).toEqual({ ok: false, reason: "read_failed" });
    }
  });

  it("refuses an active row whose identity is blank or missing", async () => {
    for (const sid of [null, undefined, "", "   ", 42]) {
      const r = await resolveStudioSmsSender(
        client(returning([{ messaging_service_sid: sid }])),
        STUDIO,
      );
      expect(r, JSON.stringify(sid)).toEqual({ ok: false, reason: "read_failed" });
    }
  });

  it("does not ask the database about a missing studio id", async () => {
    // Asking would turn a caller bug into a confident "no active sender",
    // which reads as a configuration fact and would be acted on as one.
    for (const bad of ["", "   "]) {
      const rpc = returning([{ messaging_service_sid: SID }]);
      const r = await resolveStudioSmsSender(client(rpc), bad);
      expect(r).toEqual({ ok: false, reason: "read_failed" });
      expect(rpc).not.toHaveBeenCalled();
    }
  });
});

describe("NO PLATFORM FALLBACK — the S3 law", () => {
  it("never yields a sender from the environment when the studio has none", async () => {
    // The identity `lib/sms/twilio.ts` reads today is platform-wide. If a
    // refusal could ever carry one, every studio would be back to sending from
    // Hone's shared number.
    const prevService = process.env.TWILIO_MESSAGING_SERVICE_SID;
    const prevFrom = process.env.TWILIO_FROM_NUMBER;
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MGplatformwideplatformwideplat00";
    process.env.TWILIO_FROM_NUMBER = "+15550000000";
    try {
      for (const data of [[], null]) {
        const r = await resolveStudioSmsSender(client(returning(data)), STUDIO);
        expect(r.ok).toBe(false);
        const serialized = JSON.stringify(r);
        expect(serialized).not.toContain("MGplatformwide");
        expect(serialized).not.toContain("+15550000000");
      }
    } finally {
      if (prevService === undefined) delete process.env.TWILIO_MESSAGING_SERVICE_SID;
      else process.env.TWILIO_MESSAGING_SERVICE_SID = prevService;
      if (prevFrom === undefined) delete process.env.TWILIO_FROM_NUMBER;
      else process.env.TWILIO_FROM_NUMBER = prevFrom;
    }
  });

  it("exposes a sid ONLY on ok:true", async () => {
    const refusals = [
      await resolveStudioSmsSender(client(returning([])), STUDIO),
      await resolveStudioSmsSender(client(returning(null, { message: "x" })), STUDIO),
      await resolveStudioSmsSender(
        client(returning([{ messaging_service_sid: SID }, { messaging_service_sid: SID }])),
        STUDIO,
      ),
    ];
    for (const r of refusals) {
      expect(r).not.toHaveProperty("messagingServiceSid");
    }
  });
});

describe("the send gate cannot be passed by a truthy object", () => {
  it("allows send only for ok:true", async () => {
    const good = await resolveStudioSmsSender(
      client(returning([{ messaging_service_sid: SID }])),
      STUDIO,
    );
    expect(studioSenderAllowsSend(good)).toBe(true);
  });

  it("refuses every refusal, though each is a truthy object", async () => {
    for (const data of [[], null, [{ messaging_service_sid: "" }]]) {
      const r = await resolveStudioSmsSender(client(returning(data)), STUDIO);
      expect(Boolean(r)).toBe(true); // truthy…
      expect(studioSenderAllowsSend(r)).toBe(false); // …and still not sendable
    }
  });
});

describe("this module cannot send", () => {
  it("performs exactly one RPC and no other call on the client", async () => {
    const rpc = returning([{ messaging_service_sid: SID }]);
    const from = vi.fn();
    const stub = { rpc, from } as unknown as SupabaseClient;
    await resolveStudioSmsSender(stub, STUDIO);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });
});
