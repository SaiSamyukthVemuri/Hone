import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outboundSmsFence, sendSmsSafely } from "@/lib/sms/twilio";

// SMS-00 — the outbound transport. The network is stubbed; everything else is
// real. Three facts are pinned, because the ledger and every caller depend on
// them:
//
//   1. A non-production Vercel deployment never reaches the provider.
//   2. `attempt` says whether a message can exist: `none` (no request),
//      `refused` (the provider said no), `ambiguous` (it may exist). A lost
//      answer is never reported as a refusal.
//   3. The StatusCallback is sent when asked for and only then.

const SID = `SM${"0f".repeat(16)}`;
const ENV_KEYS = [
  "VERCEL_ENV",
  "HONE_SMS_NON_PRODUCTION_SENDS",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_MESSAGING_SERVICE_SID",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let fetchMock: ReturnType<typeof vi.fn>;

function answer(status: number, body: unknown) {
  return Promise.resolve(
    new Response(body === undefined ? "<html>oops</html>" : JSON.stringify(body), { status }),
  );
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.TWILIO_ACCOUNT_SID = `AC${"1".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  fetchMock = vi.fn(() => answer(201, { sid: SID, status: "queued" }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const send = (statusCallbackUrl?: string | null) =>
  sendSmsSafely({ to: "+16475550123", body: "hello", statusCallbackUrl });

const sentForm = () => new URLSearchParams(String(fetchMock.mock.calls[0]![1]!.body));

describe("the non-production fence", () => {
  it("a preview deployment is fenced before any request (attempt none)", async () => {
    process.env.VERCEL_ENV = "preview";
    expect(await send()).toEqual({
      ok: false,
      error: "sms_fenced_non_production",
      retryable: false,
      attempt: "none",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the development environment is fenced too", () => {
    expect(outboundSmsFence({ VERCEL_ENV: "development" } as unknown as NodeJS.ProcessEnv)).toEqual({
      allowed: false,
      reason: "non_production_deployment",
    });
  });

  it("production sends (the control for the fence)", async () => {
    process.env.VERCEL_ENV = "production";
    expect(await send()).toEqual({ ok: true, messageSid: SID });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an operator can deliberately allow a non-production deployment", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.HONE_SMS_NON_PRODUCTION_SENDS = "allow";
    expect((await send()).ok).toBe(true);
  });

  it("only the exact word `allow` opens the fence", () => {
    for (const v of ["true", "1", "yes", "ALLOW"]) {
      expect(
        outboundSmsFence({ VERCEL_ENV: "preview", HONE_SMS_NON_PRODUCTION_SENDS: v } as unknown as NodeJS.ProcessEnv)
          .allowed,
        v,
      ).toBe(false);
    }
  });

  it("outside Vercel nothing is fenced here", () => {
    expect(outboundSmsFence({} as unknown as NodeJS.ProcessEnv)).toEqual({ allowed: true });
  });
});

describe("configuration gaps make no request", () => {
  it("missing credentials or sender -> attempt none", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    expect(await send()).toMatchObject({ ok: false, error: "twilio_not_configured", attempt: "none" });
    process.env.TWILIO_AUTH_TOKEN = "token";
    delete process.env.TWILIO_FROM_NUMBER;
    expect(await send()).toMatchObject({ ok: false, error: "twilio_missing_sender", attempt: "none" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("StatusCallback", () => {
  it("is sent when a URL is given", async () => {
    await send("https://hone.care/api/twilio/message-status?m=0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10");
    expect(sentForm().get("StatusCallback")).toBe(
      "https://hone.care/api/twilio/message-status?m=0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10",
    );
  });

  it("is absent otherwise", async () => {
    await send();
    expect(sentForm().has("StatusCallback")).toBe(false);
    await send(null);
    expect(new URLSearchParams(String(fetchMock.mock.calls[1]![1]!.body)).has("StatusCallback")).toBe(false);
  });
});

describe("what the provider's answer means", () => {
  it("201 with a well-formed SID is success", async () => {
    expect(await send()).toEqual({ ok: true, messageSid: SID });
  });

  it("a success status WITHOUT a usable SID is ambiguous, not a refusal", async () => {
    fetchMock.mockImplementationOnce(() => answer(201, { sid: "SMnope" }));
    expect(await send()).toMatchObject({ ok: false, attempt: "ambiguous", retryable: false });
    fetchMock.mockImplementationOnce(() => answer(201, undefined));
    expect(await send()).toMatchObject({ ok: false, attempt: "ambiguous" });
  });

  it("a 400 is refused, with Twilio's numeric code and no retry", async () => {
    fetchMock.mockImplementationOnce(() =>
      answer(400, { code: 21211, message: "The 'To' number +16475550123 is not valid.", status: 400 }),
    );
    const r = await send();
    expect(r).toEqual({
      ok: false,
      error: "twilio_http_400",
      retryable: false,
      attempt: "refused",
      providerErrorCode: 21211,
    });
    // The provider's message (which echoes the number) is not carried.
    expect(JSON.stringify(r)).not.toContain("6475550123");
  });

  it("a 429 is a refusal that may be retried", async () => {
    fetchMock.mockImplementationOnce(() => answer(429, { code: 20429 }));
    expect(await send()).toMatchObject({ attempt: "refused", retryable: true, providerErrorCode: 20429 });
  });

  it("a 5xx is ambiguous: it describes the provider, not the message", async () => {
    fetchMock.mockImplementationOnce(() => answer(503, undefined));
    expect(await send()).toMatchObject({ attempt: "ambiguous", retryable: true });
  });

  it("a timeout or a dropped connection is ambiguous", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
    expect(await send()).toMatchObject({ error: "twilio_timeout", attempt: "ambiguous" });
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("fetch failed")));
    expect(await send()).toMatchObject({ error: "twilio_network", attempt: "ambiguous" });
  });

  it("a non-numeric error code is not carried", async () => {
    fetchMock.mockImplementationOnce(() => answer(400, { code: "21211" }));
    const r = (await send()) as { attempt?: string; providerErrorCode?: number };
    expect(r.attempt).toBe("refused");
    expect(r.providerErrorCode).toBeUndefined();
  });
});
