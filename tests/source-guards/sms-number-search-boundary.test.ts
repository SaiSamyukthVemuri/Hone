import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// SMS NUMBER LOOKUP — the read-only boundary, pinned at the source.
//
// COMPANION TO sms-status-readonly-boundary.test.ts, NOT A REPLACEMENT. That
// guard pins a surface with nothing to press. This slice adds the first thing
// to press on that page, so it needs its own boundary: the lookup may ASK the
// provider a question and may not do anything else.
//
// Why source and not behaviour. The safety argument is about what the files
// contain. A lookup that quietly imported `provisionStudioSmsSender` would
// render identically and answer identically right up until someone pressed
// something, and the fence (`HONE_SMS_PROVISIONING_LIVE`, unset everywhere)
// would then be the only thing between an owner and a rented phone number.
// This guard is the layer that stops the call existing at all, so the slice
// does not depend on an environment variable staying unset.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const ACTION = "app/(app)/settings/integrations/actions.ts";
const CONTROL = "app/(app)/settings/integrations/SenderNumberSearch.tsx";
const PAGE = "app/(app)/settings/integrations/page.tsx";

// These files DISCUSS purchase, adoption and the claim by name when explaining
// what they refuse to do, so prose must not trip a "does not contain"
// assertion. LINE comments are stripped BEFORE block comments: a `//` line
// containing `/*` would otherwise leave the block stripper eating real code to
// the next `*/` and make every assertion vacuously true.
const codeOnly = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

describe("the comment stripper itself", () => {
  it("keeps code and drops prose", () => {
    const raw = read(ACTION);
    const code = codeOnly(raw);
    expect(code).toContain("export async function searchSenderNumbersAction");
    // This sentence exists only in a comment.
    expect(raw).toContain("it costs nothing and commits to nothing");
    expect(code).not.toContain("it costs nothing and commits to nothing");
  });
});

describe("the lookup reaches the provider only through the fence", () => {
  const code = codeOnly(read(ACTION));

  it("resolves the provider through resolveProvisioningProvider", () => {
    expect(code).toContain("resolveProvisioningProvider");
  });

  it("never names the real adapter", () => {
    // Importing the Twilio adapter directly is the one way to reach a real
    // provider with the flag unset. `arming`-style fences are worth nothing if
    // a caller can skip the resolver.
    expect(code).not.toContain("twilioProvisioningProvider");
    expect(code).not.toContain("twilio-provider");
  });

  it("calls only the read-only search", () => {
    expect(code).toContain("searchAvailableSenderNumbers");
  });
});

describe("no purchase, no claim, no state change", () => {
  const FORBIDDEN = [
    "provisionStudioSmsSender",
    "adoptExistingStudioSmsSender",
    "createProvisioningStore",
    "fenceProviderMutations",
    "sendProvisioningTest",
    "claim_studio_sms_provisioning",
    "finalize_studio_sms_provisioning",
    "fail_studio_sms_provisioning",
    "renew_studio_sms_lease",
    "resolve_active_studio_sms_sender",
  ] as const;

  for (const rel of [ACTION, CONTROL] as const) {
    const code = codeOnly(read(rel));
    for (const symbol of FORBIDDEN) {
      it(`${rel} never references ${symbol}`, () => {
        expect(code).not.toContain(symbol);
      });
    }
  }
});

describe("no write reaches the database from the lookup", () => {
  for (const rel of [ACTION, CONTROL] as const) {
    const code = codeOnly(read(rel));

    it(`${rel} performs no insert/update/upsert/delete`, () => {
      expect(code).not.toMatch(/\.insert\(/);
      expect(code).not.toMatch(/\.update\(/);
      expect(code).not.toMatch(/\.upsert\(/);
      expect(code).not.toMatch(/\.delete\(/);
    });

    it(`${rel} calls no RPC`, () => {
      // Every 0191/0194 command is a definer RPC. No `.rpc(` means none of
      // them — claim, finalize, fail, renew or either resolver — is reachable.
      expect(code).not.toMatch(/\.rpc\(/);
    });

    it(`${rel} constructs no service-role client`, () => {
      expect(code).not.toContain("createAdminClient");
      expect(code).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(code).not.toContain("service_role");
    });
  }
});

describe("authorization is re-derived, never accepted", () => {
  const code = codeOnly(read(ACTION));

  it("refuses a non-owner in the action itself", () => {
    // The page already redirects a non-owner. This is the direct-POST case,
    // which never rendered the page at all.
    expect(code).toMatch(/practitioner\.role !== "owner"/);
  });

  it("derives identity from the session", () => {
    expect(code).toContain("getCurrentPractitionerWithStudio");
  });

  it("reads no studio id from the form", () => {
    // The search is scoped by who is asking, not by what they sent.
    expect(code).not.toMatch(/get\("studio/i);
    expect(code).not.toContain("studioId");
  });
});

describe("no provider SID can reach the browser", () => {
  for (const rel of [ACTION, CONTROL] as const) {
    const code = codeOnly(read(rel));

    it(`${rel} names no SID field`, () => {
      // Nothing has been bought at search time, so no SID exists. 0191 also
      // withholds both SIDs from the browser's column grant, and this keeps the
      // lookup on the same side of that line.
      expect(code).not.toContain("messagingServiceSid");
      expect(code).not.toContain("phoneNumberSid");
      expect(code).not.toContain("messaging_service_sid");
      expect(code).not.toContain("phone_number_sid");
    });
  }
});

describe("the page keeps the status card's own boundary intact", () => {
  const page = codeOnly(read(PAGE));

  it("still passes the request-scoped session client to the status read", () => {
    expect(page).toContain("readOwnStudioSmsSender");
    expect(page).toMatch(/createClient\(\)/);
    expect(page).not.toContain("createAdminClient");
  });

  it("still redirects a non-owner before rendering", () => {
    expect(page).toMatch(/practitioner\.role !== "owner"/);
    expect(page).toMatch(/redirect\("\/settings\/profile"\)/);
  });

  it("offers the lookup only when there is no active sender", () => {
    // An owner who already has a sender is not shopping for another, and no
    // shipped command can switch one. A read that did not answer leaves status
    // null, which is not "active", so a transient failure does not hide it.
    expect(page).toMatch(/senderView\.status === "active" \? null/);
  });
});

describe("the control states that looking commits to nothing", () => {
  const raw = read(CONTROL);

  it("says so before the search", () => {
    expect(raw).toMatch(/does not reserve or buy/i);
  });

  it("says so again alongside the results", () => {
    // The assumption forms when a list of numbers appears, so the disclaimer
    // has to be there too and not only in the introduction.
    expect(raw).toMatch(/None of these is reserved/i);
  });

  it("carries the anchor its navigation entry points at", () => {
    // The nav entry href is /settings/integrations#sms-sender-numbers. An
    // anchor that does not exist scrolls nowhere and the search result looks
    // broken, so the id and the registration are one change.
    expect(raw).toContain('id="sms-sender-numbers"');
  });
});
