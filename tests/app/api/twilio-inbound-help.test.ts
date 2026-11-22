import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// HELP / INFO auto-reply on the inbound SMS route (appointment-SMS opt-in)
// ===========================================================================
//
// The booking checkbox says "Reply HELP for help, STOP to opt out", so the route
// must answer HELP. The reply is a TwiML <Message> to the person who wrote in:
// it sends nothing proactive, it is sent from the same number STOP is answered
// from, and it must touch NO data: no client lookup, no consent write, no
// opt-out, no audit. START / UNSTOP are deliberately NOT handled: re-subscribing
// changes consent, which is a separate decision, so they keep the existing
// behaviour (an empty TwiML, nothing stored).
//
// WHAT IS REAL: the keyword matcher and the reply text. WHAT IS SUBSTITUTED: the
// signature validator and the admin client, which throws if it is ever created,
// so "no database access" is proven by the route not creating it at all.

const h: { validSignature: boolean; adminCreated: number } = { validSignature: true, adminCreated: 0 };

vi.mock("@/lib/sms/twilio", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sms/twilio")>();
  return { ...real, validateTwilioFormRequest: () => h.validSignature };
});

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    h.adminCreated += 1;
    throw new Error("the admin client must not be created for HELP, INFO, START or UNSTOP");
  },
}));

const { POST } = await import("@/app/api/twilio/inbound-sms/route");

function post(body: Record<string, string>) {
  return POST(
    new Request("https://hone.care/api/twilio/inbound-sms", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "sig",
      },
      body: new URLSearchParams(body).toString(),
    }) as never,
  );
}

const say = (text: string) => post({ From: "+16475551234", To: "+15550001111", Body: text, MessageSid: "SM1" });

let logged: string[] = [];

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = "token";
  h.validSignature = true;
  h.adminCreated = 0;
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
});

describe("HELP and INFO are answered with the program description", () => {
  for (const word of ["HELP", "help", "  Help  ", "INFO", "info"]) {
    it(`"${word.trim()}" gets a TwiML message that names the program, the rates, STOP and a contact`, async () => {
      const res = await say(word);
      expect(res.status).toBe(200);
      const xml = await res.text();
      expect(xml).toContain("<Message>");
      expect(xml).toContain("Hone appointment texts");
      expect(xml).toContain("confirmations and reminders");
      expect(xml).toContain("Msg &amp; data rates may apply");
      expect(xml).toContain("Reply STOP to opt out");
      expect(xml).toContain("support@hone.care");
    });
  }

  it("answers without reading or writing any data and without logging the body", async () => {
    const res = await say("HELP");
    expect(res.status).toBe(200);
    expect(h.adminCreated).toBe(0);
    expect(logged.join("\n")).not.toMatch(/HELP/);
    expect(logged.join("\n")).not.toContain("+16475551234");
  });

  it("an invalid signature is refused BEFORE any keyword is looked at", async () => {
    h.validSignature = false;
    const res = await say("HELP");
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("<Message>");
  });
});

describe("nothing else changes", () => {
  for (const word of ["START", "UNSTOP", "YES", "help me", "thanks", ""]) {
    it(`"${word}" still gets an EMPTY response and touches no data`, async () => {
      const res = await say(word);
      expect(res.status).toBe(200);
      const xml = await res.text();
      expect(xml).not.toContain("<Message>");
      expect(h.adminCreated).toBe(0);
    });
  }

  it("STOP still reaches the opt-out path (it needs the database), not the HELP reply", async () => {
    // The admin client throws in this file, so reaching the STOP path surfaces
    // as an error response or a thrown error, never as the HELP text.
    let xml = "";
    try {
      const res = await say("STOP");
      xml = await res.text();
    } catch {
      xml = "";
    }
    expect(h.adminCreated).toBeGreaterThan(0);
    expect(xml).not.toContain("Hone appointment texts: confirmations");
  });
});
