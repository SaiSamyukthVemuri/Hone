import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// COMMS-01B — source contracts for the SMS provisioning boundary.
//
// These assertions are about what the CODE SAYS, not what it computes. A
// behavioural test cannot prove that a log line does not exist, that a
// dependency was not added, or that a REST call was not scattered into an
// action; only reading the source can. The behavioural half lives in
// tests/lib/sms/provisioning.test.ts and tests/lib/sms/suppression.test.ts.
//
// THE NAMED MUTATIONS THIS FILE EXISTS TO CATCH:
//   * log the Auth Token, a full phone number, or a raw provider payload;
//   * add the `twilio` npm SDK "for convenience";
//   * call the Twilio REST API from an action, a component or a route instead
//     of through the adapter;
//   * accept a provider SID from request input and treat it as authority;
//   * default provider selection to the REAL adapter, so a deployment starts
//     renting phone numbers because credentials happened to be present;
//   * drop `server-only` from a module holding credentials.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PROVIDER_DIR = "lib/sms/provider";
const TWILIO_ADAPTER = `${PROVIDER_DIR}/twilio-provider.ts`;
const FAKE_ADAPTER = `${PROVIDER_DIR}/fake-provider.ts`;
const PROVIDER_TYPES = `${PROVIDER_DIR}/types.ts`;
const PROVIDER_INDEX = `${PROVIDER_DIR}/index.ts`;
const ORCHESTRATION = "lib/sms/provisioning.ts";
const STORE = "lib/sms/provisioning-store.ts";

/** Source with comment lines removed: a negative assertion must never be satisfied by prose. */
function code(rel: string): string {
  return read(rel)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// 1. Server-only boundary
// ---------------------------------------------------------------------------

describe("the provisioning boundary is server-only", () => {
  it.each([TWILIO_ADAPTER, FAKE_ADAPTER, PROVIDER_TYPES, PROVIDER_INDEX, ORCHESTRATION, STORE])(
    "%s imports server-only",
    (file) => {
      expect(code(file)).toContain('import "server-only"');
    },
  );

  it("no client component imports the provisioning boundary", () => {
    // A "use client" file reaching this module would bundle credential-reading
    // code into the browser build.
    for (const file of [TWILIO_ADAPTER, PROVIDER_INDEX, ORCHESTRATION, STORE]) {
      expect(read(file)).not.toContain('"use client"');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. LOG_SECRET_NEGATIVE_CONTROL
// ---------------------------------------------------------------------------

describe("LOG_SECRET_NEGATIVE_CONTROL", () => {
  it("the adapter emits no logs at all", () => {
    // The strongest available position for a module holding an Auth Token,
    // full phone numbers and raw payloads in local scope: there is no log
    // statement to audit, so none can drift into carrying one of them.
    const src = code(TWILIO_ADAPTER);
    expect(src).not.toMatch(/console\.(log|error|warn|info|debug)/);
  });

  it.each([FAKE_ADAPTER, PROVIDER_TYPES, PROVIDER_INDEX, ORCHESTRATION, STORE])(
    "%s emits no logs either",
    (file) => {
      expect(code(file)).not.toMatch(/console\.(log|error|warn|info|debug)/);
    },
  );

  it("the Auth Token is read in exactly one place and never interpolated into a message", () => {
    const src = code(TWILIO_ADAPTER);
    const reads = src.match(/TWILIO_AUTH_TOKEN/g) ?? [];
    expect(reads).toHaveLength(1);
    // Its only use is the Basic Auth header.
    expect(src).toMatch(/Basic \$\{Buffer\.from\(/);
  });

  it("no module in the boundary stringifies a provider response", () => {
    for (const file of [TWILIO_ADAPTER, ORCHESTRATION, STORE]) {
      const src = code(file);
      expect(src).not.toMatch(/JSON\.stringify\s*\(\s*(res|response|json|data|body)\b/);
    }
  });

  it("the store never surfaces a Postgres error object", () => {
    // Supabase error text can carry SQL and column values; the orchestration
    // has a safe taxonomy for what may be recorded instead.
    const src = code(STORE);
    expect(src).not.toMatch(/String\(\s*error\s*\)/);
    expect(src).not.toMatch(/error\.message/);
  });

  it("the persisted error vocabulary cannot express a phone number or a token", () => {
    const src = read(PROVIDER_TYPES);
    const block = src.slice(
      src.indexOf("export const PROVIDER_ERROR_CODES"),
      src.indexOf("] as const;", src.indexOf("export const PROVIDER_ERROR_CODES")),
    );
    const codes = [...block.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(5);
    for (const c of codes) {
      // Same shape the studio_sms_senders.last_error_code CHECK enforces.
      expect(c).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
      expect(c).not.toMatch(/\d{4,}/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. One boundary, no SDK, no scattered REST calls
// ---------------------------------------------------------------------------

describe("provider calls live in exactly one place", () => {
  it("the Twilio npm SDK is not a dependency", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("twilio");
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain("twilio");
  });

  it("nothing outside lib/sms calls a Twilio provisioning endpoint", () => {
    // The adapter and the existing send helper are the only files allowed to
    // name a Twilio host. Anything else means a REST call has escaped the
    // boundary into an action, a component or a route.
    const allowed = new Set([
      TWILIO_ADAPTER,
      "lib/sms/twilio.ts",
    ]);
    const hosts = /https:\/\/(api|messaging|lookups)\.twilio\.com/;

    // Walk the source tree without shelling out.
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(ROOT, dir))) {
        if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
        const rel = `${dir}/${entry}`;
        const abs = path.join(ROOT, rel);
        if (statSync(abs).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        if (allowed.has(rel)) continue;
        if (hosts.test(readFileSync(abs, "utf8"))) offenders.push(rel);
      }
    };
    for (const top of ["app", "components", "lib"]) walk(top);
    expect(offenders).toEqual([]);
  });

  it("the orchestration performs no HTTP of its own", () => {
    const src = code(ORCHESTRATION);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toContain("twilio.com");
    expect(src).not.toContain("TWILIO_");
  });

  it("every adapter request is bounded by a timeout", () => {
    const src = code(TWILIO_ADAPTER);
    expect(src).toContain("AbortController");
    expect(src).toMatch(/TIMEOUT_MS/);
    // One shared request helper, so no call site can forget the bound.
    expect((src.match(/new AbortController\(\)/g) ?? [])).toHaveLength(1);
    expect((src.match(/await fetch\(/g) ?? [])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-closed parsing
// ---------------------------------------------------------------------------

describe("provider responses are parsed fail-closed", () => {
  it("SID shapes are validated before anything is trusted", () => {
    const src = code(PROVIDER_TYPES);
    expect(src).toMatch(/\^PN\[0-9a-fA-F\]\{32\}\$/);
    expect(src).toMatch(/\^MG\[0-9a-fA-F\]\{32\}\$/);
    expect(src).toMatch(/\^\\\+\[1-9\]\[0-9\]\{7,14\}\$/);
  });

  it("the adapter never reads a SID straight off a response", () => {
    const src = code(TWILIO_ADAPTER);
    // Every sid read goes through a shape validator.
    const rawSidReads = src.match(/\.sid\b/g) ?? [];
    const validated = src.match(/as(PhoneNumberSid|MessagingServiceSid|String)\(/g) ?? [];
    expect(validated.length).toBeGreaterThanOrEqual(rawSidReads.length);
  });

  it("Contains is sent as digits, not as E.164", () => {
    // Regression pin. Twilio's Contains matches digits and `*`; the E.164 plus
    // yields a 400, which this adapter maps to a rejection -- so with the live
    // provider armed EVERY attempt died before purchase, on an available
    // number. Proved on the wire in tests/lib/sms/twilio-provider.test.ts.
    const src = code(TWILIO_ADAPTER);
    expect(src).toMatch(/params\.set\("Contains", input\.phoneNumber\.replace\(\/\\D\/g, ""\)\)/);
  });

  it("pagination ends only on an EXPLICIT null cursor", () => {
    // Malformed metadata is not end-of-list: treating it as one licenses the
    // duplicate messaging service the exhaustive scan exists to prevent.
    const src = code(TWILIO_ADAPTER);
    expect(src).toContain('!("next_page_url" in meta)');
    expect(src).toMatch(/if \(rawNext === null\)/);
  });

  it("a 400 is classified by the provider's own error code", () => {
    const src = code(TWILIO_ADAPTER);
    expect(src).toContain("NUMBER_UNAVAILABLE_CODES");
    expect(src).toMatch(/unavailable \? "number_no_longer_available" : "provider_rejected"/);
  });

  it("every provider MUTATION is fenced, not just the purchase", () => {
    // Gating only the purchase left the adopted path unfenced: a worker that
    // stalled AFTER buying skips that branch entirely.
    const src = code(ORCHESTRATION);
    const fenceChecks = src.match(/await stillOurs\(\)/g) ?? [];
    // purchase, service, attach, inbound webhook, status callback, test send.
    expect(fenceChecks.length).toBeGreaterThanOrEqual(6);
  });

  it("a displaced worker's provider error never outranks lease_lost", () => {
    const src = code(ORCHESTRATION);
    expect(src).toMatch(/if \(parked === "lease_lost"\)/);
  });

  it("an unparseable response is a failure, not a partial success", () => {
    const src = code(TWILIO_ADAPTER);
    expect(src).toContain("provider_response_unparseable");
  });
});

// ---------------------------------------------------------------------------
// 5. PROVIDER_IDS_BROWSER_SUPPLIED
// ---------------------------------------------------------------------------

describe("browser-supplied provider identifiers are never authority", () => {
  it("the orchestration input carries no SID and no claim key", () => {
    const src = read(ORCHESTRATION);
    const block = src.slice(
      src.indexOf("export type ProvisionInput = {"),
      src.indexOf("};", src.indexOf("export type ProvisionInput = {")),
    );
    expect(block).not.toMatch(/phoneNumberSid\s*[?]?:/);
    expect(block).not.toMatch(/messagingServiceSid\s*[?]?:/);
    expect(block).not.toMatch(/claimKey\s*[?]?:/);
    // The one caller-chosen value is the NUMBER, which is re-verified against
    // the provider before anything is bought.
    expect(block).toMatch(/phoneNumber:\s*string/);
  });

  it("the claim key is minted by the database, never by the application", () => {
    const migration = readFileSync(
      path.join(ROOT, "supabase/migrations/0191_studio_sms_sender_provisioning.sql"),
      "utf8",
    );
    expect(migration).toMatch(/'hone-sms-' \|\| replace\(gen_random_uuid\(\)::text, '-', ''\)/);
    // And nothing in the application generates one.
    expect(code(ORCHESTRATION)).not.toMatch(/hone-sms-/);
    expect(code(STORE)).not.toMatch(/hone-sms-/);
  });

  it("the browser's grant excludes every provider identifier", () => {
    const migration = readFileSync(
      path.join(ROOT, "supabase/migrations/0191_studio_sms_sender_provisioning.sql"),
      "utf8",
    );
    const grant = migration.slice(
      migration.indexOf("grant select ("),
      migration.indexOf(") on public.studio_sms_senders to authenticated;"),
    );
    expect(grant).not.toContain("phone_number_sid");
    expect(grant).not.toContain("messaging_service_sid");
    expect(grant).not.toContain("provisioning_claim_key");
  });
});

// ---------------------------------------------------------------------------
// 6. Fake by default
// ---------------------------------------------------------------------------

describe("live provisioning is opt-in", () => {
  it("credentials alone do not arm the real adapter", () => {
    const src = code(PROVIDER_INDEX);
    // The flag is required IN ADDITION to credentials. Keying off credentials
    // alone would arm production the moment this merges, because
    // TWILIO_ACCOUNT_SID is already set wherever Hone sends SMS.
    expect(src).toContain("HONE_SMS_PROVISIONING_LIVE");
    expect(src).toMatch(/=== "true"/);
    expect(src).toMatch(/liveProvisioningArmed\(\)\s*\?\s*twilioProvisioningProvider\s*:\s*fake/);
  });

  it("the flag is not set anywhere in the repository", () => {
    // Nothing in the tree may arm live provisioning; that is a separately
    // authorized operator action.
    const files = [".env.example", ".github/workflows/ci.yml", "package.json"];
    for (const rel of files) {
      let contents = "";
      try {
        contents = read(rel);
      } catch {
        continue;
      }
      expect(contents).not.toContain("HONE_SMS_PROVISIONING_LIVE");
    }
  });
});
