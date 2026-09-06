import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// COMMS-01B2. A studio's message must leave from that studio's own number.
//
// Before this slice every studio-scoped SMS left from one deployment-global
// sender read out of process.env, which no caller could influence. With a
// second studio that is wrong in a way the recipient can see, and it is silent:
// nothing errors, the wrong number simply appears on someone's phone.
//
// The mutation control at the bottom is the load-bearing test. Without it this
// whole file could pass while an environment fallback quietly survives
// underneath, which is exactly the failure being removed.

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...a: unknown[]) => fetchMock(...a));

import {
  resolveActiveStudioSender,
  SENDER_AMBIGUOUS_ERROR,
  SENDER_NOT_ACTIVE_ERROR,
  SENDER_READ_FAILED_ERROR,
} from "@/lib/sms/sender-routing";
import { sendSmsSafely } from "@/lib/sms/twilio";

const A_SID = "MG00000000000000000000000000000a";
const B_SID = "MG00000000000000000000000000000b";

/** Minimal admin double over the 0192 RPC. Records what it was asked. */
function adminRpc(
  rows: Array<{ messaging_service_sid: string | null }> | null,
  error: { message: string } | null = null,
) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: rows, error };
    },
  };
  return { client: client as never, calls };
}

function adminThrowing() {
  return {
    rpc: async () => {
      throw new Error("connection reset");
    },
  } as never;
}

beforeEach(() => {
  fetchMock.mockReset();
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
});
afterEach(() => {
  delete process.env.TWILIO_MESSAGING_SERVICE_SID;
  delete process.env.TWILIO_FROM_NUMBER;
});

describe("resolution goes through the 0192 definer lookup, not the table", () => {
  it("calls resolve_active_studio_sms_sender with the studio id", async () => {
    const { client, calls } = adminRpc([{ messaging_service_sid: A_SID }]);
    const r = await resolveActiveStudioSender(client, "studio-a");
    expect(r).toEqual({ ok: true, sender: { messagingServiceSid: A_SID } });
    expect(calls).toHaveLength(1);
    // 0191 revokes ALL on studio_sms_senders from service_role, so a direct
    // select could never have worked. The RPC is the only route.
    expect(calls[0].fn).toBe("resolve_active_studio_sms_sender");
    expect(calls[0].args).toEqual({ p_studio_id: "studio-a" });
  });

  it("Studio B resolves B's sender — the two never share a value", async () => {
    const { client } = adminRpc([{ messaging_service_sid: B_SID }]);
    const r = await resolveActiveStudioSender(client, "studio-b");
    expect(r.ok && r.sender.messagingServiceSid).toBe(B_SID);
    expect(B_SID).not.toBe(A_SID);
  });

  it("zero rows is `none_active` — a fact about the studio", async () => {
    const { client } = adminRpc([]);
    expect(await resolveActiveStudioSender(client, "studio-c")).toEqual({
      ok: false,
      reason: "none_active",
    });
  });

  it("an RPC error is `read_failed`, NOT `none_active`", async () => {
    // A privilege or transport failure says nothing about whether a sender
    // exists, and must not send an operator to provision one.
    const { client } = adminRpc(null, { message: "42501 permission denied" });
    expect(await resolveActiveStudioSender(client, "studio-a")).toEqual({
      ok: false,
      reason: "read_failed",
    });
  });

  it("a thrown transport error is also `read_failed`", async () => {
    expect(await resolveActiveStudioSender(adminThrowing(), "studio-a")).toEqual({
      ok: false,
      reason: "read_failed",
    });
  });

  it("TWO active rows fail closed — never pick-first", async () => {
    // 0191's one-live-per-studio index should make this unreachable. If the
    // invariant is ever violated, sending from an arbitrarily chosen number is
    // worse than not sending.
    const { client } = adminRpc([
      { messaging_service_sid: A_SID },
      { messaging_service_sid: B_SID },
    ]);
    expect(await resolveActiveStudioSender(client, "studio-a")).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("a row with a null SID is refused, not sent as an empty sender", async () => {
    const { client } = adminRpc([{ messaging_service_sid: null }]);
    expect(await resolveActiveStudioSender(client, "studio-a")).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("an empty studio id resolves nothing and issues no lookup", async () => {
    const { client, calls } = adminRpc([{ messaging_service_sid: A_SID }]);
    expect(await resolveActiveStudioSender(client, "")).toEqual({
      ok: false,
      reason: "none_active",
    });
    expect(calls).toHaveLength(0);
  });

  it("the three failure tags are distinct strings", () => {
    const tags = [
      SENDER_NOT_ACTIVE_ERROR,
      SENDER_READ_FAILED_ERROR,
      SENDER_AMBIGUOUS_ERROR,
    ];
    expect(new Set(tags).size).toBe(3);
  });
});

describe("the transport sends exactly the sender it was handed", () => {
  function okResponse() {
    return {
      ok: true,
      status: 201,
      json: async () => ({ sid: "SM1" }),
    };
  }

  it("puts Studio A's SID on the wire", async () => {
    fetchMock.mockResolvedValue(okResponse());
    const r = await sendSmsSafely({
      to: "+15550001111",
      body: "hi",
      messagingServiceSid: A_SID,
    });
    expect(r.ok).toBe(true);
    const body = String((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toContain(`MessagingServiceSid=${A_SID}`);
    expect(body).not.toContain(B_SID);
  });

  it("Studio A can never transmit Studio B's SID", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await sendSmsSafely({ to: "+1555", body: "x", messagingServiceSid: A_SID });
    expect(
      String((fetchMock.mock.calls[0][1] as { body: string }).body),
    ).not.toContain(B_SID);
  });

  it("never emits a bare From= — routing is by messaging service only", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await sendSmsSafely({ to: "+1555", body: "x", messagingServiceSid: A_SID });
    expect(
      String((fetchMock.mock.calls[0][1] as { body: string }).body),
    ).not.toMatch(/(^|&)From=/);
  });

  it("an empty sender refuses and NEVER reaches the provider", async () => {
    const r = await sendSmsSafely({ to: "+1555", body: "x", messagingServiceSid: "" });
    expect(r).toEqual({
      ok: false,
      error: "twilio_missing_sender",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("provider failure semantics are unchanged", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const r = await sendSmsSafely({ to: "+1555", body: "x", messagingServiceSid: A_SID });
    expect(r).toEqual({ ok: false, error: "twilio_http_500", retryable: true });

    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    const bad = await sendSmsSafely({ to: "+1555", body: "x", messagingServiceSid: A_SID });
    expect(bad).toEqual({ ok: false, error: "twilio_http_400", retryable: false });
  });
});

// ---------------------------------------------------------------------------
// MUTATION CONTROL — the test that makes the rest non-vacuous
// ---------------------------------------------------------------------------
describe("MUTATION CONTROL — a restored global fallback must be detectable", () => {
  it("the deployment-global sender cannot rescue an unrouted send", async () => {
    // Both legacy env vars are set, exactly as a production deployment has
    // them. If anyone reinstates the `process.env` fallback inside
    // sendSmsSafely, this send starts succeeding from Hone's shared number and
    // this assertion turns RED — which is the whole purpose of the test.
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MGglobalglobalglobalglobalglob";
    process.env.TWILIO_FROM_NUMBER = "+15550009999";

    const r = await sendSmsSafely({ to: "+1555", body: "x", messagingServiceSid: "" });

    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a configured global sender is never placed on the wire", async () => {
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MGglobalglobalglobalglobalglob";
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ sid: "SM1" }) });

    await sendSmsSafely({ to: "+1555", body: "x", messagingServiceSid: A_SID });

    const body = String((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toContain(A_SID);
    expect(body).not.toContain("MGglobalglobalglobalglobalglob");
  });
});
