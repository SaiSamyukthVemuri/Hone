import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// SMS SENDER STATUS — the read-only boundary, pinned at the source.
//
// The slice's entire safety argument is that this surface CANNOT perform a
// provider effect: it constructs no provider, calls no orchestration, takes no
// claim and writes nothing. That is a property of what the files contain, and a
// browser assertion cannot see it — a card that quietly imported
// `provisionStudioSmsSender` would render identically right up until someone
// pressed something.
//
// The provider-effect fence (`HONE_SMS_PROVISIONING_LIVE`, unset everywhere)
// already means a stray call would hit the fake rather than spend money. This
// guard is the layer that stops the call existing at all, so the slice does not
// depend on an environment variable staying unset.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const STATUS_LIB = "lib/sms/sender-status.ts";
const CARD = "app/(app)/settings/integrations/SmsSenderStatusCard.tsx";
const PAGE = "app/(app)/settings/integrations/page.tsx";

// These files DISCUSS provisioning, adoption and the claim by name when
// explaining what they refuse to do, so prose must not trip a "does not
// contain" assertion. LINE comments are stripped BEFORE block comments: a `//`
// line containing `/*` would otherwise leave the block stripper eating real
// code to the next `*/` and make every assertion vacuously true.
const codeOnly = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const SURFACES = [
  { name: "sender-status lib", rel: STATUS_LIB },
  { name: "status card", rel: CARD },
] as const;

describe("the comment stripper itself", () => {
  it("keeps code and drops prose", () => {
    const raw = read(STATUS_LIB);
    const code = codeOnly(raw);
    expect(code).toContain("export function presentSenderStatus");
    // This sentence exists only in a comment.
    expect(raw).toContain("It reads. That");
    expect(code).not.toContain("It reads. That");
  });
});

describe("no provider, no orchestration, no claim", () => {
  const FORBIDDEN = [
    "provisionStudioSmsSender",
    "adoptExistingStudioSmsSender",
    "searchAvailableSenderNumbers",
    "createProvisioningStore",
    "resolveProvisioningProvider",
    "liveProvisioningArmed",
    "twilioProvisioningProvider",
    "FakeSmsProvisioningProvider",
    "fenceProviderMutations",
    "sendProvisioningTest",
    "renewLease",
  ] as const;

  for (const { name, rel } of SURFACES) {
    const code = codeOnly(read(rel));
    for (const symbol of FORBIDDEN) {
      it(`${name} never references ${symbol}`, () => {
        expect(code).not.toContain(symbol);
      });
    }
  }
});

describe("no write reaches studio_sms_senders from this surface", () => {
  for (const { name, rel } of SURFACES) {
    const code = codeOnly(read(rel));

    it(`${name} performs no insert/update/upsert/delete`, () => {
      expect(code).not.toMatch(/\.insert\(/);
      expect(code).not.toMatch(/\.update\(/);
      expect(code).not.toMatch(/\.upsert\(/);
      expect(code).not.toMatch(/\.delete\(/);
    });

    it(`${name} calls no RPC`, () => {
      // Every 0191/0194 command is a definer RPC. No `.rpc(` means none of
      // them — claim, finalize, fail, renew or either resolver — is reachable.
      expect(code).not.toMatch(/\.rpc\(/);
    });
  }
});

describe("authority is the database's, not this module's", () => {
  const code = codeOnly(read(STATUS_LIB));

  it("never constructs a service-role client", () => {
    // A service-role client would bypass 0191's RLS policy AND its column
    // grant, making this module the thing granting access.
    expect(code).not.toContain("createAdminClient");
    expect(code).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(code).not.toContain("service_role");
  });

  it("takes the caller's client as an argument rather than making one", () => {
    expect(code).toMatch(/client:\s*SupabaseClient/);
    expect(code).not.toContain('from "@/lib/supabase/server"');
  });

  it("the page passes the request-scoped session client", () => {
    const page = codeOnly(read(PAGE));
    expect(page).toContain("readOwnStudioSmsSender");
    expect(page).toMatch(/createClient\(\)/);
    expect(page).not.toContain("createAdminClient");
  });

  it("the page stays owner-only", () => {
    // Defence in depth: RLS already scopes the row, and the page redirects a
    // non-owner before it renders anything.
    const page = codeOnly(read(PAGE));
    expect(page).toMatch(/practitioner\.role !== "owner"/);
    expect(page).toMatch(/redirect\("\/settings\/profile"\)/);
  });
});

describe("the card is a server component with nothing to press", () => {
  const raw = read(CARD);
  const code = codeOnly(raw);

  it("declares no client boundary", () => {
    // A status card has no state and no event. If it ever needs "use client",
    // that is a different component with a different review.
    expect(raw).not.toMatch(/^"use client";/m);
  });

  it("renders no control that could start anything", () => {
    expect(code).not.toMatch(/<button/i);
    expect(code).not.toMatch(/<form/i);
    expect(code).not.toContain("onClick");
    expect(code).not.toContain("onSubmit");
    expect(code).not.toContain("useTransition");
    expect(code).not.toContain("action=");
  });

  it("communicates state as words, not colour alone", () => {
    // The border tone is reinforcement; the headline and the tone LABEL carry
    // the state for anyone who cannot distinguish the colours.
    expect(code).toContain("TONE_LABEL");
    expect(code).toContain("{view.headline}");
  });
});
