import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #187. submitWaitlistEntry and submitDemoRequest are anonymous
// landing-page actions that insert directly into waitlist /
// demo_requests; before this PR they had no rate limit and could be
// scripted to fill the database. These source-grep tests pin: both
// actions check the shared lib/rate-limit/public.ts limiter with the
// normalized email BEFORE the Supabase insert, the refusal is the
// shared generic message, and the limiter buckets are namespaced,
// hashed and fail-open with the windows decided in the PR (5/h per
// IP, 2/d per email).

const ROOT = path.resolve(__dirname, "../../..");
const WAITLIST = readFileSync(
  path.join(ROOT, "app/actions/waitlist.ts"),
  "utf8",
);
const DEMO = readFileSync(path.join(ROOT, "app/actions/demo.ts"), "utf8");
const LIMITER = readFileSync(
  path.join(ROOT, "lib/rate-limit/public.ts"),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const WAITLIST_CODE = codeOnly(WAITLIST);
const DEMO_CODE = codeOnly(DEMO);
const LIMITER_CODE = codeOnly(LIMITER);

describe("waitlist action: rate-limited via shared infrastructure", () => {
  it("checks the limiter with the NORMALIZED email", () => {
    expect(WAITLIST_CODE).toMatch(
      /limitWaitlistSubmit\(\{\s*\n?\s*headers: await headers\(\),\s*\n?\s*email: normalized,\s*\n?\s*\}\)/,
    );
  });

  it("rate-limit check happens BEFORE the Supabase insert", () => {
    const limitIdx = WAITLIST_CODE.indexOf("limitWaitlistSubmit(");
    const insertIdx = WAITLIST_CODE.indexOf('.from("waitlist")');
    expect(limitIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(limitIdx);
  });

  it("refusal returns the shared generic message, not a custom oracle", () => {
    expect(WAITLIST_CODE).toMatch(
      /if \(!rate\.allowed\) \{\s*\n?\s*return \{ ok: false, error: RATE_LIMIT_MESSAGE \};/,
    );
    expect(WAITLIST_CODE).not.toMatch(/already submitted|blocked/i);
  });
});

describe("demo request action: rate-limited via shared infrastructure", () => {
  it("checks the limiter with the normalized email variable", () => {
    expect(DEMO_CODE).toMatch(
      /limitDemoRequestSubmit\(\{\s*\n?\s*headers: await headers\(\),\s*\n?\s*email,\s*\n?\s*\}\)/,
    );
    expect(DEMO_CODE).toMatch(
      /const email = payload\.email\.trim\(\)\.toLowerCase\(\);/,
    );
  });

  it("rate-limit check happens BEFORE the Supabase insert", () => {
    const limitIdx = DEMO_CODE.indexOf("limitDemoRequestSubmit(");
    const insertIdx = DEMO_CODE.indexOf('.from("demo_requests")');
    expect(limitIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(limitIdx);
  });

  it("refusal returns the shared generic message", () => {
    expect(DEMO_CODE).toMatch(
      /if \(!rate\.allowed\) \{\s*\n?\s*return \{ ok: false, error: RATE_LIMIT_MESSAGE \};/,
    );
  });
});

describe("limiter module: marketing form buckets", () => {
  it("declares the marketing windows: 5/1h per IP, 2/1d per email", () => {
    expect(LIMITER_CODE).toMatch(
      /ip: \{ limit: 5, window: "1 h" \}/,
    );
    expect(LIMITER_CODE).toMatch(
      /email: \{ limit: 2, window: "1 d" \}/,
    );
  });

  it("namespaces prefixes per form so buckets never collide", () => {
    expect(LIMITER_CODE).toMatch(/prefix: `rl:\$\{form\}_\$\{dimension\}`/);
    // The booking/portal prefixes are distinct strings, so no overlap.
    expect(LIMITER_CODE).toMatch(/prefix: "rl:public_book_ip"/);
    expect(LIMITER_CODE).toMatch(/prefix: "rl:portal_login_ip"/);
  });

  it("hashes IP and email before they become Redis keys", () => {
    const block = LIMITER_CODE.slice(
      LIMITER_CODE.indexOf("async function limitMarketingForm"),
      LIMITER_CODE.indexOf("export async function limitWaitlistSubmit"),
    );
    expect(block).toMatch(/ipLimiter\.limit\(hashId\(ip\)\)/);
    expect(block).toMatch(/emailLimiter\.limit\(hashId\(args\.email\)\)/);
  });

  it("fails open on backend errors, matching the file's design contract", () => {
    const block = LIMITER_CODE.slice(
      LIMITER_CODE.indexOf("async function limitMarketingForm"),
      LIMITER_CODE.indexOf("export async function limitWaitlistSubmit"),
    );
    expect(block).toMatch(/logBackendUnavailable\(form, err\)/);
    expect(block).toMatch(/return \{ allowed: true \};\s*\/\/ fail open/);
  });
});

describe("public form actions do not log", () => {
  it("no raw request-body or PII logging in either action (code only)", () => {
    expect(WAITLIST_CODE).not.toMatch(/console\./);
    expect(DEMO_CODE).not.toMatch(/console\./);
  });
});
