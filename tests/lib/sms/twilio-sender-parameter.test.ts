import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSmsSafely } from "@/lib/sms/twilio";

// ===========================================================================
// WAIT S3 PART 2 — the PROVIDER PRIMITIVE has no sender of its own
//
// WHY THIS FILE EXISTS, AND WHAT IT CAUGHT.
//
// `studio-sender-routing.test.ts` proves the SYSTEM refuses when a studio has
// no sender. It cannot prove this primitive has no env fallback, because on
// every refusal path routing stops the call before `sendSmsSafely` is ever
// reached — so a fallback living here is simply unreachable from those tests.
//
// A mutation control demonstrated exactly that: reintroducing
// `messagingServiceSid || process.env.TWILIO_MESSAGING_SERVICE_SID` in
// twilio.ts left all 34 routing tests GREEN. The system-level proof was real
// but did not cover the primitive. This file covers the primitive directly.
//
// Both env keys are set to usable values throughout, so a fallback shows up as
// a WRONG sender rather than as an absent one.
// ===========================================================================

const GIVEN_SID = "MGgivenbythecaller00000000000000000";
const PLATFORM_SID = "MGplatformwideshared00000000000000";
const PLATFORM_FROM = "+15550000000";

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  process.env.TWILIO_MESSAGING_SERVICE_SID = PLATFORM_SID;
  process.env.TWILIO_FROM_NUMBER = PLATFORM_FROM;
  fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ sid: "SMx", status: "queued" }), { status: 201 }),
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function postedBody(): string {
  return String((fetchSpy.mock.calls[0]![1] as RequestInit).body);
}

describe("the caller's sender is the ONLY sender", () => {
  it("posts exactly what it was given", async () => {
    const r = await sendSmsSafely({
      to: "+14165551234",
      body: "hi",
      messagingServiceSid: GIVEN_SID,
    });
    expect(r.ok).toBe(true);
    expect(postedBody()).toContain(`MessagingServiceSid=${GIVEN_SID}`);
  });

  it("ignores a usable platform sender sitting in the environment", async () => {
    await sendSmsSafely({
      to: "+14165551234",
      body: "hi",
      messagingServiceSid: GIVEN_SID,
    });
    const body = postedBody();
    expect(body).not.toContain(PLATFORM_SID);
    expect(body).not.toContain(encodeURIComponent(PLATFORM_FROM));
  });

  it("never emits the legacy From parameter", async () => {
    await sendSmsSafely({
      to: "+14165551234",
      body: "hi",
      messagingServiceSid: GIVEN_SID,
    });
    expect(postedBody()).not.toContain("From=");
  });
});

describe("a blank sender is a REFUSAL, not an invitation to fall back", () => {
  // The type makes this required, but an untyped or JS caller can still reach
  // here with a blank string. Falling back would restore the platform-wide
  // identity through the one door routing cannot guard.
  const blanks: unknown[] = ["", "   ", null, undefined];

  it.each(blanks.map((v) => [JSON.stringify(v), v] as const))(
    "refuses %s with twilio_missing_sender and issues zero fetch",
    async (_label, value) => {
      const r = await sendSmsSafely({
        to: "+14165551234",
        body: "hi",
        messagingServiceSid: value as string,
      });
      expect(r).toEqual({
        ok: false,
        error: "twilio_missing_sender",
        retryable: false,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("still refuses when BOTH env sender keys are valid", async () => {
    expect(process.env.TWILIO_MESSAGING_SERVICE_SID).toBe(PLATFORM_SID);
    expect(process.env.TWILIO_FROM_NUMBER).toBe(PLATFORM_FROM);
    const r = await sendSmsSafely({ to: "+14165551234", body: "hi", messagingServiceSid: "" });
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses even with the env keys DELETED — no hidden second source", async () => {
    delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    delete process.env.TWILIO_FROM_NUMBER;
    const r = await sendSmsSafely({ to: "+14165551234", body: "hi", messagingServiceSid: "" });
    expect(r).toEqual({
      ok: false,
      error: "twilio_missing_sender",
      retryable: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("provider AUTHENTICATION is still environment-owned", () => {
  // The split this unit preserves: sender identity comes from the studio,
  // account credentials remain deployment configuration.
  it("refuses without TWILIO_ACCOUNT_SID, before any sender check", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    const r = await sendSmsSafely({
      to: "+14165551234",
      body: "hi",
      messagingServiceSid: GIVEN_SID,
    });
    expect(r).toEqual({
      ok: false,
      error: "twilio_not_configured",
      retryable: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses without TWILIO_AUTH_TOKEN", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const r = await sendSmsSafely({
      to: "+14165551234",
      body: "hi",
      messagingServiceSid: GIVEN_SID,
    });
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a valid send still authenticates with the env credentials", async () => {
    await sendSmsSafely({
      to: "+14165551234",
      body: "hi",
      messagingServiceSid: GIVEN_SID,
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from("ACtest:tok").toString("base64")}`);
  });
});

describe("the module reads NO sender from the environment", () => {
  it("has no process.env sender read left in its source", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(__dirname, "../../../lib/sms/twilio.ts"),
      "utf8",
    );
    // Comments explain the removal, so strip them before asserting on code.
    const code = src.replace(/\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(code).not.toContain("TWILIO_MESSAGING_SERVICE_SID");
    expect(code).not.toContain("TWILIO_FROM_NUMBER");
    // …while provider authentication legitimately remains.
    expect(code).toContain("TWILIO_ACCOUNT_SID");
    expect(code).toContain("TWILIO_AUTH_TOKEN");
  });
});
