import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { senderControlsGate } from "@/lib/sms/sender-controls";
import {
  SENDER_CONTROLS_LIVE_STUDIOS_ENV,
  checkLiveTestText,
  checkPurchaseConfirmation,
  liveGateFor,
  liveSenderControlsProvider,
  liveStudioAllowlist,
} from "@/lib/sms/sender-controls-live";

// SMS-SENDER-LIVE-GATE-01 (HON-50 G1 + G3). The live mode ships CLOSED and
// opens only for: production, outbound fence open, live provisioning armed,
// and a studio on the operator allowlist. No Twilio credential appears here:
// arming is injected.

const STUDIO = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const OTHER = "11111111-2222-4333-8444-555555555555";
const armed = () => true;
const unarmed = () => false;
const LIVE = {
  HONE_SMS_SENDER_CONTROLS: "live",
  VERCEL_ENV: "production",
  [SENDER_CONTROLS_LIVE_STUDIOS_ENV]: STUDIO,
};

describe("liveStudioAllowlist: fail closed", () => {
  it("is empty when unset or blank", () => {
    expect(liveStudioAllowlist({}).size).toBe(0);
    expect(liveStudioAllowlist({ [SENDER_CONTROLS_LIVE_STUDIOS_ENV]: "  " }).size).toBe(0);
  });

  it("parses UUIDs, trimmed and case-insensitive", () => {
    const set = liveStudioAllowlist({ [SENDER_CONTROLS_LIVE_STUDIOS_ENV]: ` ${STUDIO.toUpperCase()} , ${OTHER}` });
    expect([...set].sort()).toEqual([OTHER, STUDIO].sort());
  });

  it("is EMPTY when any entry is malformed: a typo never opens anything", () => {
    for (const raw of [`${STUDIO},`, `${STUDIO},not-a-uuid`, "*", "all", `${STUDIO};${OTHER}`, "true"]) {
      expect(liveStudioAllowlist({ [SENDER_CONTROLS_LIVE_STUDIOS_ENV]: raw }).size, raw).toBe(0);
    }
  });
});

describe("liveGateFor / senderControlsGate live branch", () => {
  it("opens only with every condition, for the allowlisted studio", () => {
    expect(senderControlsGate(LIVE, armed, STUDIO)).toEqual({ open: true, mode: "live" });
    expect(senderControlsGate(LIVE, armed, STUDIO.toUpperCase())).toEqual({ open: true, mode: "live" });
  });

  it("refuses each missing condition, in order", () => {
    for (const v of [undefined, "preview", "development", "staging"]) {
      expect(senderControlsGate({ ...LIVE, VERCEL_ENV: v }, armed, STUDIO), String(v)).toEqual({ open: false, reason: "live_not_production" });
    }
    expect(liveGateFor({ ...LIVE }, STUDIO, unarmed)).toEqual({ open: false, reason: "live_not_armed" });
    expect(senderControlsGate(LIVE, armed, OTHER)).toEqual({ open: false, reason: "live_not_allowlisted" });
    expect(senderControlsGate(LIVE, armed, null)).toEqual({ open: false, reason: "live_not_allowlisted" });
    expect(senderControlsGate({ ...LIVE, [SENDER_CONTROLS_LIVE_STUDIOS_ENV]: undefined }, armed, STUDIO)).toEqual({
      open: false,
      reason: "live_not_allowlisted",
    });
  });

  it("is not opened by the fake mode's conditions, and never demotes to fake", () => {
    // A local, loopback run with live requested: refused, NOT the fake.
    expect(senderControlsGate({ ...LIVE, VERCEL_ENV: undefined, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }, unarmed, STUDIO)).toEqual({
      open: false,
      reason: "live_not_production",
    });
    // And the fake mode still never opens live, whatever else is set.
    expect(senderControlsGate({ ...LIVE, HONE_SMS_SENDER_CONTROLS: "fake" }, armed, STUDIO)).toEqual({ open: false, reason: "production" });
  });

  it("the outbound fence outranks arming: a fenced deployment never opens live", () => {
    // outboundSmsFence only fences non-production Vercel envs, which the
    // production check already refuses; pin that the order cannot let one through.
    expect(senderControlsGate({ ...LIVE, VERCEL_ENV: "preview", HONE_SMS_NON_PRODUCTION_SENDS: "allow" }, armed, STUDIO)).toEqual({
      open: false,
      reason: "live_not_production",
    });
  });
});

describe("liveSenderControlsProvider", () => {
  it("throws rather than hand back the fake when live is not armed", () => {
    expect(() => liveSenderControlsProvider(unarmed)).toThrow(/not armed/);
  });
});

describe("G3: checkPurchaseConfirmation", () => {
  const base = { phoneNumber: "+12125550101", confirmNumber: "+12125550101", confirmCost: "yes", testDestination: "", confirmTestText: "" };

  it("fake: needs the cost confirmation, bound to THIS number", () => {
    expect(checkPurchaseConfirmation({ ...base, mode: "fake" })).toEqual({ ok: true, testDestination: null });
    expect(checkPurchaseConfirmation({ ...base, mode: "fake", confirmCost: "" })).toEqual({ ok: false, reason: "purchase_not_confirmed" });
    expect(checkPurchaseConfirmation({ ...base, mode: "fake", confirmCost: "on" })).toEqual({ ok: false, reason: "purchase_not_confirmed" });
    expect(checkPurchaseConfirmation({ ...base, mode: "fake", confirmNumber: "+12125550102" })).toEqual({ ok: false, reason: "confirmation_number_mismatch" });
    expect(checkPurchaseConfirmation({ ...base, mode: "fake", confirmNumber: "" })).toEqual({ ok: false, reason: "confirmation_number_mismatch" });
    expect(checkPurchaseConfirmation({ ...base, mode: "fake", phoneNumber: "", confirmNumber: "" })).toEqual({ ok: false, reason: "confirmation_number_mismatch" });
  });

  it("live: also needs the owner's own phone and agreement to the test text", () => {
    expect(checkPurchaseConfirmation({ ...base, mode: "live" })).toEqual({ ok: false, reason: "test_text_not_confirmed" });
    expect(checkPurchaseConfirmation({ ...base, mode: "live", confirmTestText: "yes", testDestination: "" })).toEqual({ ok: false, reason: "test_destination_invalid" });
    for (const bad of ["4165550123", "+18885550123", "+18765550123", "+44 20 7946 0000", "not a phone"]) {
      expect(checkPurchaseConfirmation({ ...base, mode: "live", confirmTestText: "yes", testDestination: bad }), bad).toEqual({ ok: false, reason: "test_destination_invalid" });
    }
    expect(checkPurchaseConfirmation({ ...base, mode: "live", confirmTestText: "yes", testDestination: " +14165550123 " })).toEqual({ ok: true, testDestination: "+14165550123" });
    // The cost confirmation is checked first in live mode too.
    expect(checkPurchaseConfirmation({ ...base, mode: "live", confirmCost: "", confirmTestText: "yes", testDestination: "+14165550123" })).toEqual({ ok: false, reason: "purchase_not_confirmed" });
  });

  it("checkLiveTestText (live adoption)", () => {
    expect(checkLiveTestText({ testDestination: "+12125550123", confirmTestText: "yes" })).toEqual({ ok: true, testDestination: "+12125550123" });
    expect(checkLiveTestText({ testDestination: "+12125550123", confirmTestText: "" })).toEqual({ ok: false, reason: "test_text_not_confirmed" });
  });
});

describe("ships closed, and one path to the real adapter (source guards)", () => {
  const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");

  // git grep searches TRACKED files and exits 1 on no match; only that is "none".
  // ALWAYS -a: lib/ops/redact.ts carries a deliberate NUL sentinel, so git
  // treats it as binary, and -I (or a binary short-circuit) would silently
  // skip it. A guard that cannot see a file is not a guard.
  function gitGrep(args: string[]): string[] {
    try {
      return execFileSync("git", ["grep", "-a", ...args], { encoding: "utf8" }).split("\n").filter(Boolean);
    } catch (e) {
      if ((e as { status?: number }).status === 1) return [];
      throw e;
    }
  }

  it("no studio is allowlisted, and live mode is enabled nowhere, in any tracked file", () => {
    expect(gitGrep(["-l", "-e", SENDER_CONTROLS_LIVE_STUDIOS_ENV, "--", ".", ":!tests/**", ":!docs/**"])).toEqual(["lib/sms/sender-controls-live.ts"]);
    expect(
      // Comments may NAME the mode; no code, config or seed may SET it.
      gitGrep(["-n", "-E", "HONE_SMS_SENDER_CONTROLS\\s*[=:]\\s*['\"]?live", "--", ".", ":!tests/**", ":!docs/**", ":!lib/sms/sender-controls-live.ts"]).filter(
        (hit) => !/^[^:]+:\d+:\s*(\/\/|\*|#)/.test(hit),
      ),
    ).toEqual([]);
  });

  it("only sender-controls-live reaches the provider resolver; the actions take every provider from providerFor", () => {
    const liveSrc = strip(readFileSync("lib/sms/sender-controls-live.ts", "utf8"));
    expect(liveSrc).toContain("resolveProvisioningProvider()");
    const lib = strip(readFileSync("lib/sms/sender-controls.ts", "utf8"));
    const actions = strip(readFileSync("app/(app)/settings/integrations/sender-control-actions.ts", "utf8"));
    for (const forbidden of ["resolveProvisioningProvider", "twilioProvisioningProvider", "twilio-provider"]) {
      expect(lib, forbidden).not.toContain(forbidden);
      expect(actions, forbidden).not.toContain(forbidden);
    }
    expect(actions.match(/providerFor\(ctx\)/g)).toHaveLength(4);
    expect(actions.match(/senderControlsFakeProvider\(/g)).toHaveLength(1);
    expect(actions.match(/liveSenderControlsProvider\(/g)).toHaveLength(1);
  });

  it("the grep sees binary-detected text files: lib/ops/redact.ts is scanned, not skipped", () => {
    // If -a were dropped, git would skip this NUL-bearing file and every
    // "nowhere in the repo" assertion above would be blind to it.
    expect(gitGrep(["-l", "-e", "", "--", "lib/ops/redact.ts"])).toEqual(["lib/ops/redact.ts"]);
    expect(gitGrep(["-c", "-e", "export", "--", "lib/ops/redact.ts"])[0]).toMatch(/^lib\/ops\/redact\.ts:[1-9]/);
  });

  it("every caller asks the gate about a studio: the live branch is per studio (Codex P1 4301418258)", () => {
    const callers = gitGrep(["-n", "-E", "senderControlsGate\\(", "--", "app"]);
    expect(callers.length).toBeGreaterThanOrEqual(3);
    for (const hit of callers) {
      expect(hit, hit).toMatch(/senderControlsGate\(process\.env, undefined, (studio\.id|studioId)\)/);
    }
  });

  it("the live section never runs the demo-inventory read", () => {
    const section = strip(readFileSync("app/(app)/settings/integrations/SmsSenderControlsSection.tsx", "utf8"));
    const live = section.indexOf('gate.mode === "live"');
    const demo = section.indexOf("resolveDemoInventory(");
    expect(live).toBeGreaterThan(-1);
    expect(demo).toBeGreaterThan(live);
  });
});
