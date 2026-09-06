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
  SENDER_NOT_ACTIVE_ERROR,
  SENDER_READ_FAILED_ERROR,
} from "@/lib/sms/sender-routing";
import { sendSmsSafely } from "@/lib/sms/twilio";

const A_SID = "MG00000000000000000000000000000a";
const B_SID = "MG00000000000000000000000000000b";

/** Minimal admin double: records the filters it was given, answers once. */
function adminReturning(
  row: { messaging_service_sid: string } | null,
  error: { message: string } | null = null,
) {
  const filters: Record<string, unknown> = {};
  const client = {
    from(table: string) {
      filters.table = table;
      const chain = {
        select(cols: string) {
          filters.select = cols;
          return chain;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        maybeSingle: async () => ({ data: row, error }),
      };
      return chain;
    },
  };
  return { client: client as never, filters };
}

function adminThrowing() {
  return {
    from() {
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

describe("resolution reads only this studio's ACTIVE row", () => {
  it("Studio A resolves A's sender", async () => {
    const { client, filters } = adminReturning({ messaging_service_sid: A_SID });
    const r = await resolveActiveStudioSender(client, "studio-a");
    expect(r).toEqual({ ok: true, sender: { messagingServiceSid: A_SID } });
    expect(filters.table).toBe("studio_sms_senders");
    expect(filters.studio_id).toBe("studio-a");
    // `active` is a PROOF under 0191's readiness check, so it is the only
    // status that may be routed to.
    expect(filters.status).toBe("active");
  });

  it("Studio B resolves B's sender — the two never share a value", async () => {
    const { client } = adminReturning({ messaging_service_sid: B_SID });
    const r = await resolveActiveStudioSender(client, "studio-b");
    expect(r.ok && r.sender.messagingServiceSid).toBe(B_SID);
    expect(B_SID).not.toBe(A_SID);
  });

  it("no ACTIVE row is `none_active` — a fact about the studio", async () => {
    const { client } = adminReturning(null);
    expect(await resolveActiveStudioSender(client, "studio-c")).toEqual({
      ok: false,
      reason: "none_active",
    });
  });

  it("a driver error is `read_failed`, NOT `none_active`", async () => {
    // The distinction is the point: an unreadable table says nothing about
    // whether a sender exists, and must not send an operator to provision one.
    const { client } = adminReturning(null, { message: "57014 canceled" });
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

  it("an empty studio id resolves nothing and issues no query", async () => {
    const { client, filters } = adminReturning({ messaging_service_sid: A_SID });
    expect(await resolveActiveStudioSender(client, "")).toEqual({
      ok: false,
      reason: "none_active",
    });
    expect(filters.table).toBeUndefined();
  });

  it("the two failure tags are distinct strings", () => {
    expect(SENDER_NOT_ACTIVE_ERROR).not.toBe(SENDER_READ_FAILED_ERROR);
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
