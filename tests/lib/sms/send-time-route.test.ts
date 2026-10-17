import { describe, expect, it, vi } from "vitest";
import {
  STUDIO_ROUTING_ENV,
  decideStudioRoute,
  resolveSendTimeRoute,
  studioRoutingMode,
  unavailableSendTimeRouteReader,
  type SendTimeRegistration,
  type SendTimeRouteRead,
  type SendTimeSender,
} from "@/lib/sms/send-time-route";

// ===========================================================================
// WILLOW-ROUTING-CANDIDATE-01 (#824): the send-time route decision, alone.
// ===========================================================================
//
// Synthetic only: every studio, sender, messaging service and number here is
// invented. The readiness model and registration mapping are the SMS lane's
// own (lib/sms/sender-readiness.ts, lib/sms/sender-registration.ts), used
// unchanged. Cases are chosen to hold under both the current and the
// corrected destination matrix: a Canadian long code to a Canadian recipient,
// toll-free verification, and stale evidence on a replaced sender.

const A = "studio-a";
const B = "studio-b";
const CA_RECIPIENT = "+16475550123";
const US_RECIPIENT = "+12125550123";
const CA_SENDER_NUMBER = "+14165550100";
const TOLL_FREE_SENDER_NUMBER = "+18885550100";
const MSID_A = `MG${"a".repeat(32)}`;
const MSID_B = `MG${"b".repeat(32)}`;

// READINESS (#841 fe89a006): a Canadian or US LONG CODE is never an eligible
// A2P route to CANADIAN recipients. The default ready sender is therefore a
// toll-free number with complete, approved verification of that exact number,
// which is Active for both Canadian and US recipients.
const sender = (over: Partial<SendTimeSender> = {}): SendTimeSender => ({
  id: "sender-a-1",
  studio_id: A,
  status: "active",
  phone_number: TOLL_FREE_SENDER_NUMBER,
  messaging_service_sid: MSID_A,
  ...over,
});

const registration = (over: Partial<SendTimeRegistration> = {}): SendTimeRegistration => ({
  studio_id: A,
  sender_id: "sender-a-1",
  phone_number: TOLL_FREE_SENDER_NUMBER,
  kind: "toll_free_verification",
  status: "approved",
  missing_information: null,
  ...over,
});

const read = (senders: SendTimeSender[], registrations: SendTimeRegistration[] = [registration()]): SendTimeRouteRead => ({
  ok: true,
  senders,
  registrations,
});

const decide = (r: SendTimeRouteRead, recipientE164 = CA_RECIPIENT, studioId = A) =>
  decideStudioRoute({ studioId, recipientE164, read: r });

describe("the cutover gate: every studio stays on the platform sender unless listed", () => {
  it("unset, empty or blank: platform", () => {
    expect(studioRoutingMode(A, {})).toBe("platform");
    expect(studioRoutingMode(A, { [STUDIO_ROUTING_ENV]: "" })).toBe("platform");
    expect(studioRoutingMode(A, { [STUDIO_ROUTING_ENV]: " , ," })).toBe("platform");
  });

  it("only an exact listed id routes; another studio's listing, or a prefix, does not", () => {
    expect(studioRoutingMode(A, { [STUDIO_ROUTING_ENV]: `${B}, ${A}` })).toBe("studio");
    expect(studioRoutingMode(A, { [STUDIO_ROUTING_ENV]: B })).toBe("platform");
    expect(studioRoutingMode("s-1", { [STUDIO_ROUTING_ENV]: "s-10,s-1x" })).toBe("platform");
  });

  it("a blank studio id never routes, whatever is listed", () => {
    expect(studioRoutingMode("", { [STUDIO_ROUTING_ENV]: "" })).toBe("platform");
    expect(studioRoutingMode(" ", { [STUDIO_ROUTING_ENV]: " " })).toBe("platform");
  });

  it("platform mode reads nothing", async () => {
    const reader = vi.fn(async () => read([sender()]));
    expect(await resolveSendTimeRoute({ studioId: A, recipientE164: CA_RECIPIENT, reader, env: {} })).toEqual({
      ok: true,
      mode: "platform",
    });
    expect(reader).not.toHaveBeenCalled();
  });

  it("the production reader is unreadable, so a listed studio refuses rather than sends", async () => {
    expect(await unavailableSendTimeRouteReader(A)).toEqual({ ok: false });
    expect(
      await resolveSendTimeRoute({ studioId: A, recipientE164: CA_RECIPIENT, env: { [STUDIO_ROUTING_ENV]: A } }),
    ).toEqual({ ok: false, reason: "sender_read_failed" });
  });

  it("a reader that throws is a refusal, never a send", async () => {
    const reader = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(
      await resolveSendTimeRoute({ studioId: A, recipientE164: CA_RECIPIENT, reader, env: { [STUDIO_ROUTING_ENV]: A } }),
    ).toEqual({ ok: false, reason: "sender_read_failed" });
  });
});

describe("the studio's own sender, or nothing", () => {
  it("a ready (verified toll-free) sender to a Canadian recipient routes through exactly that sender", () => {
    expect(decide(read([sender()]))).toEqual({
      ok: true,
      mode: "studio",
      messagingServiceSid: MSID_A,
      fromNumber: TOLL_FREE_SENDER_NUMBER,
      senderId: "sender-a-1",
      destination: "CA",
    });
  });

  it("an unreadable answer, or a malformed one, refuses", () => {
    expect(decide({ ok: false })).toEqual({ ok: false, reason: "sender_read_failed" });
    expect(decide({ ok: true, senders: null, registrations: [] } as unknown as SendTimeRouteRead)).toEqual({
      ok: false,
      reason: "sender_read_failed",
    });
  });

  it("a malformed row (null, or not an object) refuses rather than throws", () => {
    for (const bad of [null, 7, "row"]) {
      expect(decide(read([bad as unknown as SendTimeSender]))).toEqual({ ok: false, reason: "sender_read_failed" });
      expect(decide(read([sender()], [bad as unknown as SendTimeRegistration]))).toEqual({
        ok: false,
        reason: "sender_read_failed",
      });
    }
  });

  it("WRONG STUDIO: Studio B's ready sender is never used for Studio A", () => {
    expect(decide(read([sender({ id: "sender-b-1", studio_id: B, messaging_service_sid: MSID_B })]))).toEqual({
      ok: false,
      reason: "sender_wrong_studio",
    });
  });

  it("WRONG STUDIO: a foreign row beside A's own still refuses, rather than being filtered away", () => {
    const r = read([sender(), sender({ id: "sender-b-1", studio_id: B, status: "released", messaging_service_sid: MSID_B })]);
    expect(decide(r)).toEqual({ ok: false, reason: "sender_wrong_studio" });
  });

  it("no ACTIVE sender: none, off, provisioning, suspended, error or released", () => {
    expect(decide(read([]))).toEqual({ ok: false, reason: "no_active_sender" });
    for (const status of ["off", "selecting", "provisioning", "suspended", "error", "releasing", "released"] as const) {
      expect(decide(read([sender({ status })]))).toEqual({ ok: false, reason: "no_active_sender" });
    }
  });

  it("two ACTIVE senders is a broken invariant: neither is chosen", () => {
    expect(decide(read([sender(), sender({ id: "sender-a-2", messaging_service_sid: MSID_B })]))).toEqual({
      ok: false,
      reason: "ambiguous_active_sender",
    });
  });

  it("WRONG SENDER: an active row without a messaging service is not a sending identity", () => {
    for (const messaging_service_sid of [null, "", "   "]) {
      expect(decide(read([sender({ messaging_service_sid })]))).toEqual({
        ok: false,
        reason: "sender_identity_missing",
      });
    }
  });
});

describe("THE CANADIAN RULE (#841 fe89a006): a long code is never an A2P route to Canada", () => {
  const US_LONG_CODE = "+12065550100";
  const tenDlc = (phone: string, id = "sender-a-1") =>
    registration({ sender_id: id, phone_number: phone, kind: "us_10dlc", status: "approved" });

  it("a Canadian long code to a Canadian recipient: refused before any claim", () => {
    expect(decide(read([sender({ phone_number: CA_SENDER_NUMBER })], []), CA_RECIPIENT)).toEqual({
      ok: false,
      reason: "destination_not_ready",
      readiness: "requires_information",
    });
  });

  it("even with approved 10DLC for that exact long code, Canada is refused; the US is served", () => {
    const r = read([sender({ phone_number: CA_SENDER_NUMBER })], [tenDlc(CA_SENDER_NUMBER)]);
    expect(decide(r, CA_RECIPIENT)).toEqual({ ok: false, reason: "destination_not_ready", readiness: "requires_information" });
    expect(decide(r, US_RECIPIENT)).toMatchObject({ ok: true, mode: "studio", fromNumber: CA_SENDER_NUMBER, destination: "US" });
  });

  it("a US long code with approved 10DLC serves US recipients only", () => {
    const r = read([sender({ phone_number: US_LONG_CODE })], [tenDlc(US_LONG_CODE)]);
    expect(decide(r, US_RECIPIENT)).toMatchObject({ ok: true, fromNumber: US_LONG_CODE, destination: "US" });
    expect(decide(r, CA_RECIPIENT)).toEqual({ ok: false, reason: "destination_not_ready", readiness: "requires_information" });
  });

  it("verified toll-free serves both countries; unverified toll-free serves neither", () => {
    const verified = read([sender()]);
    expect(decide(verified, CA_RECIPIENT)).toMatchObject({ ok: true, destination: "CA" });
    expect(decide(verified, US_RECIPIENT)).toMatchObject({ ok: true, destination: "US" });
    const unverified = read([sender()], []);
    expect(decide(unverified, CA_RECIPIENT)).toMatchObject({ ok: false, reason: "destination_not_ready" });
    expect(decide(unverified, US_RECIPIENT)).toMatchObject({ ok: false, reason: "destination_not_ready" });
  });
});

describe("UNREADY RECIPIENT: only a Canadian or US number is a destination", () => {
  for (const [label, to] of [
    ["a toll-free number", "+18005550123"],
    ["a non-NANP number", "+447700900123"],
    ["an unformatted number", "6475550123"],
    ["an N11 area code", "+14115550123"],
    ["an empty value", ""],
  ] as const) {
    it(`${label} refuses before any readiness is consulted`, () => {
      expect(decide(read([sender()]), to)).toEqual({ ok: false, reason: "recipient_unroutable" });
    });
  }
});

describe("STALE REGISTRATION: only the live sender's own evidence counts", () => {
  const tollFree = sender({ id: "sender-a-2", phone_number: TOLL_FREE_SENDER_NUMBER });

  it("the control: approved verification on THIS sender routes", () => {
    const r = decide(read([tollFree], [registration({ sender_id: "sender-a-2" })]), US_RECIPIENT);
    expect(r).toMatchObject({ ok: true, mode: "studio", senderId: "sender-a-2", destination: "US" });
  });

  it("approval recorded for the studio's PREVIOUS sender is never inherited", () => {
    const r = decide(
      read(
        [tollFree, sender({ id: "sender-a-1", status: "released", messaging_service_sid: null })],
        [registration({ sender_id: "sender-a-1" })],
      ),
      US_RECIPIENT,
    );
    expect(r).toEqual({ ok: false, reason: "destination_not_ready", readiness: "requires_information" });
  });

  it("approval recorded for the number this sender USED to hold is never inherited", () => {
    const r = decide(
      read([tollFree], [registration({ sender_id: "sender-a-2", phone_number: "+18775550100" })]),
      US_RECIPIENT,
    );
    expect(r).toEqual({ ok: false, reason: "destination_not_ready", readiness: "requires_information" });
  });

  it("approval on this sender id but recorded for ANOTHER studio is ignored", () => {
    const r = decide(read([tollFree], [registration({ sender_id: "sender-a-2", studio_id: B })]), US_RECIPIENT);
    expect(r).toEqual({ ok: false, reason: "destination_not_ready", readiness: "requires_information" });
  });

  it("evidence of the wrong kind says nothing about this number", () => {
    const r = decide(read([tollFree], [registration({ sender_id: "sender-a-2", kind: "us_10dlc" })]), US_RECIPIENT);
    expect(r).toEqual({ ok: false, reason: "destination_not_ready", readiness: "requires_information" });
  });

  for (const [status, readiness] of [
    ["pending", "pending"],
    ["rejected", "failed"],
    ["suspended", "suspended"],
  ] as const) {
    it(`this sender's own ${status} verification refuses as ${readiness}`, () => {
      const r = decide(read([tollFree], [registration({ sender_id: "sender-a-2", status })]), US_RECIPIENT);
      expect(r).toEqual({ ok: false, reason: "destination_not_ready", readiness });
    });
  }

  it("a sender number that does not classify is never ready", () => {
    const r = decide(read([sender({ phone_number: "+1555" })]));
    expect(r).toEqual({ ok: false, reason: "destination_not_ready", readiness: "failed" });
  });
});
