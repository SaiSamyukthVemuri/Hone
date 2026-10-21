import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { senderControlsGate } from "@/lib/sms/sender-controls";

// SMS-SENDER-CONTROL-01: the controls open ONLY in the explicit fake mode,
// never in production and never with live provisioning armed.

const never = () => false;
/** The local stack: the only database these controls may write to. */
const LOCAL = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" };
const armed = () => true;

describe("senderControlsGate", () => {
  it("opens only for HONE_SMS_SENDER_CONTROLS=fake", () => {
    expect(senderControlsGate({ ...LOCAL, HONE_SMS_SENDER_CONTROLS: "fake" }, never)).toEqual({ open: true, mode: "fake" });
    // "live" is its own branch (HON-50, tests/lib/sms/sender-controls-live.test.ts)
    // and never opens the fake one.
    for (const v of [undefined, "", "true", "LIVE", "FAKE"]) {
      expect(senderControlsGate({ ...LOCAL, HONE_SMS_SENDER_CONTROLS: v }, never), String(v)).toEqual({ open: false, reason: "not_enabled" });
    }
  });

  it("stays shut on a Vercel PREVIEW, which uses the production database (Codex P1 4251747841)", () => {
    for (const env of ["preview", "staging", "anything-hosted"]) {
      expect(senderControlsGate({ ...LOCAL, HONE_SMS_SENDER_CONTROLS: "fake", VERCEL_ENV: env }, never), env).toEqual({ open: false, reason: "hosted_deployment" });
    }
    expect(senderControlsGate({ ...LOCAL, HONE_SMS_SENDER_CONTROLS: "fake", VERCEL_ENV: "development" }, never)).toEqual({ open: true, mode: "fake" });
    expect(senderControlsGate({ ...LOCAL, HONE_SMS_SENDER_CONTROLS: "fake" }, never)).toEqual({ open: true, mode: "fake" });
  });

  it("stays shut in production, whatever the flag says", () => {
    expect(senderControlsGate({ ...LOCAL, HONE_SMS_SENDER_CONTROLS: "fake", VERCEL_ENV: "production" }, never)).toEqual({ open: false, reason: "production" });
  });

  it("stays shut in a SELF-HOSTED production runtime and against any non-local database (Codex P2 4266736587)", () => {
    const fake = { HONE_SMS_SENDER_CONTROLS: "fake" };
    // `next start` in production, no VERCEL_ENV, pointed at the hosted project.
    expect(senderControlsGate({ ...fake, NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://alhhybgqdmcdyzpybykj.supabase.co" }, never)).toEqual({ open: false, reason: "not_local_database" });
    // ... or with no database URL at all, a LAN host, a lookalike or a malformed value.
    for (const url of [undefined, "", "http://10.0.0.5:54321", "http://127.0.0.1.evil.example", "https://localhost.example.com", "not a url"]) {
      expect(senderControlsGate({ ...fake, NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: url }, never), String(url)).toEqual({ open: false, reason: "not_local_database" });
    }
    // `next dev` against the hosted project is shut too: NODE_ENV is not the authority.
    expect(senderControlsGate({ ...fake, NODE_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: "https://alhhybgqdmcdyzpybykj.supabase.co" }, never)).toEqual({ open: false, reason: "not_local_database" });
    // A deployed platform's own markers refuse even with a loopback URL.
    for (const marker of [{ VERCEL: "1" }, { AWS_REGION: "us-east-1" }, { AWS_EXECUTION_ENV: "AWS_Lambda_nodejs20.x" }]) {
      expect(senderControlsGate({ ...LOCAL, ...fake, NODE_ENV: "production", ...marker }, never), JSON.stringify(marker)).toEqual({ open: false, reason: "deployed_runtime" });
    }
  });

  it("opens for a LOCAL production build (next start against the loopback stack), as the e2e lane and the local twin run", () => {
    for (const url of ["http://127.0.0.1:54321", "http://localhost:55821", "http://[::1]:54321"]) {
      expect(senderControlsGate({ HONE_SMS_SENDER_CONTROLS: "fake", NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: url }, never), url).toEqual({ open: true, mode: "fake" });
    }
  });

  it("stays shut when live provisioning is armed (a click could buy a number)", () => {
    expect(senderControlsGate({ ...LOCAL, HONE_SMS_SENDER_CONTROLS: "fake" }, armed)).toEqual({ open: false, reason: "live_provisioning_armed" });
  });
});

describe("the actions reach the fake provider unless the live gate opened (source guard)", () => {
  const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  const actions = strip(readFileSync("app/(app)/settings/integrations/sender-control-actions.ts", "utf8"));
  const lib = strip(readFileSync("lib/sms/sender-controls.ts", "utf8"));

  it("the actions pass the controls' own seeded FAKE explicitly and never resolve a provider", () => {
    // Per studio (Codex P2 4251747847): every action, release included, takes
    // its provider from providerFor, whose fake branch is this studio's fake
    // and whose live branch is sender-controls-live (HON-50).
    expect(actions.match(/providerFor\(ctx\)/g)).toHaveLength(4);
    expect(actions).toMatch(/ctx\.mode === "live" \? liveSenderControlsProvider\(\) : senderControlsFakeProvider\(getRequiredAppOrigin\(\), ctx\.studioId\)/);
    expect(lib).toMatch(/new FakeSmsProvisioningProvider\(\{/);
    for (const forbidden of ["resolveProvisioningProvider", "twilioProvisioningProvider", "twilio-provider"]) {
      expect(actions, forbidden).not.toContain(forbidden);
      expect(lib, forbidden).not.toContain(forbidden);
    }
  });

  it("every action checks the gate before anything else", () => {
    for (const name of ["searchSenderNumbersAction", "provisionSenderNumberAction", "adoptSenderNumberAction", "releaseSenderClaimAction"]) {
      const body = actions.slice(actions.indexOf(`export async function ${name}`));
      const firstAwait = body.indexOf("await ");
      expect(body.slice(firstAwait, firstAwait + 30), name).toContain("ownerContext()");
    }
    // The studio is resolved server-side first (the live branch is per studio),
    // then the gate, before any other check.
    expect(actions).toMatch(/const gate = senderControlsGate\(process\.env, undefined, studio\.id\);\s*\n\s*if \(!gate\.open\)/);
  });
});

describe("numberMatchesCountry / areaCodeMatchesCountry (Codex P2 4250699105)", () => {
  it("uses the NANP classifier: CA is CA, US is US, toll-free and other NANP are neither", async () => {
    const { numberMatchesCountry, areaCodeMatchesCountry } = await import("@/lib/sms/sender-controls");
    expect(numberMatchesCountry("+14165550101", "CA")).toBe(true);
    expect(numberMatchesCountry("+14165550101", "US")).toBe(false);
    expect(numberMatchesCountry("+12125550101", "US")).toBe(true);
    expect(numberMatchesCountry("+18885550101", "US")).toBe(false);
    expect(numberMatchesCountry("+18765550101", "US")).toBe(false);
    expect(numberMatchesCountry("not a number", "CA")).toBe(false);
    expect(areaCodeMatchesCountry("604", "CA")).toBe(true);
    expect(areaCodeMatchesCountry("604", "US")).toBe(false);
    expect(areaCodeMatchesCountry("12", "US")).toBe(false);
  });
});

describe("the searched area code reaches provisioning (Codex P2 4253781002)", () => {
  it("each candidate's provisioning form carries the search's area code", async () => {
    const src = readFileSync("app/(app)/settings/integrations/SmsSenderControls.tsx", "utf8");
    expect(src).toMatch(/search\.areaCode \? <input type="hidden" name="area_code" value=\{search\.areaCode\} \/> : null/);
    expect(readFileSync("app/(app)/settings/integrations/sender-control-actions.ts", "utf8")).toMatch(/areaCode: str\(formData, "area_code"\) \|\| null/);
  });
});
