import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { SEED, appEnv, clientListShowsClient, localDemoKeys, originalSha256, photoBytesMatch, providerFenceViolations, recordRendersFields, signIn, uncontainedSentryRecords } from "../../scripts/ops/restore-drill-app-check.mjs";

// DR-01A. The application-readability check runs only in its own CI job
// (.github/workflows/restore-drill.yml), against a real restored stack. These
// cases pin what can be proved without one: the closed server environment, the
// three read verdicts, the sign-in cookie, and the drill's exit-code contract.

const API = "http://127.0.0.1:56521";
const env = () =>
  appEnv({ api: API, anonKey: "anon", serviceKey: "service", egressLog: "/tmp/x.jsonl", runId: "drill-abcdef123456" });

describe("the server environment is closed and every provider is fenced", () => {
  it("is fenced as built: no Twilio, no Google, fakes armed, guard preloaded", () => {
    const e = env();
    expect(providerFenceViolations(e)).toEqual([]);
    expect(Object.keys(e).filter((k) => /TWILIO|GOOGLE/.test(k))).toEqual([]);
    expect(e.NODE_OPTIONS).toContain("e2e/helpers/sentry-egress-guard.cjs");
  });

  it("inherits nothing from the shell but PATH and HOME", () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC0");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    try {
      expect(env().TWILIO_ACCOUNT_SID).toBeUndefined();
      expect(env().STRIPE_SECRET_KEY).toBe("sk_test_dummy");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["Twilio set", { TWILIO_ACCOUNT_SID: "AC0" }, /TWILIO_ACCOUNT_SID is set/],
    ["a Google credential", { GOOGLE_CLIENT_SECRET: "x" }, /GOOGLE_CLIENT_SECRET is set/],
    ["a deployed-runtime signal", { VERCEL: "1" }, /deployed-runtime signal/],
    ["no fake Resend", { HONE_E2E_FAKE_RESEND: "0" }, /fake Resend/],
    ["no fake Stripe", { HONE_E2E_FAKE_STRIPE: "" }, /fake Stripe/],
    ["a live Stripe key", { STRIPE_SECRET_KEY: "sk_live_x" }, /not a test key/],
    ["no Sentry guard", { NODE_OPTIONS: "" }, /Sentry egress guard is not preloaded/],
    ["a hosted Supabase URL", { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" }, /hosted Supabase/],
  ])("refuses %s", (_name, override, message) => {
    expect(providerFenceViolations({ ...env(), ...override }).join("\n")).toMatch(message);
  });
});

describe("the three reads", () => {
  const listHtml = `<a href="/clients/${SEED.clientId}" class="x"><div class="truncate font-medium">${SEED.clientName}</div></a>`;
  const recordHtml = `<h1 class="break-words">${SEED.clientName}</h1><p class="mt-1">${SEED.note}</p>`;

  it("client list: the seeded client's link and rendered name", () => {
    expect(clientListShowsClient(200, listHtml)).toBeNull();
    expect(clientListShowsClient(307, "")).toMatch(/answered 307/);
    expect(clientListShowsClient(200, "<p>No clients yet.</p>")).toMatch(/no link/);
    // The name only inside a serialized payload is not a rendered row.
    expect(clientListShowsClient(200, `href="/clients/${SEED.clientId}" {"name":"${SEED.clientName}"}`)).toMatch(/not rendered/);
  });

  it("client record: the heading and the restored clinical note", () => {
    expect(recordRendersFields(200, recordHtml)).toBeNull();
    expect(recordRendersFields(404, recordHtml)).toMatch(/answered 404/);
    expect(recordRendersFields(200, `<h1>Someone else</h1><p>${SEED.note}</p>`)).toMatch(/heading/);
    expect(recordRendersFields(200, `<h1>${SEED.clientName}</h1>`)).toMatch(/clinical note/);
  });

  it("photo: the app-signed URL's bytes hash equal to the original", () => {
    const bytes = Buffer.from("synthetic bytes");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const url = `${API}/storage/v1/object/sign/treatment-images/a/b/synthetic-1.png?token=t`;
    expect(photoBytesMatch(200, url, 200, bytes, sha)).toBeNull();
    expect(photoBytesMatch(200, url, 200, Buffer.from("other"), sha)).toMatch(/!= original/);
    expect(photoBytesMatch(200, url, 200, bytes, null)).toMatch(/unknown/);
    expect(photoBytesMatch(404, undefined, 0, Buffer.alloc(0), sha)).toMatch(/answered 404/);
    expect(photoBytesMatch(200, "https://elsewhere.example/x", 200, bytes, sha)).toMatch(/not the drill's storage/);
    expect(photoBytesMatch(200, url, 400, bytes, sha)).toMatch(/signed URL answered 400/);
  });

  it("reads the original hash of obj-1.bin from the drill's evidence", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "drill-sha-"));
    try {
      const f = path.join(dir, "objects-before.sha256");
      writeFileSync(f, `${"a".repeat(64)}  obj-1.bin\n${"b".repeat(64)}  obj-2.bin\n`);
      expect(originalSha256(f)).toBe("a".repeat(64));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Sentry guard records count as contained only when sunk or refused", () => {
    const log = [{ kind: "envelope" }, { kind: "refused" }].map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(uncontainedSentryRecords(log)).toEqual([]);
    expect(uncontainedSentryRecords(`${log}{"kind":"forwarded"}\n`)).toEqual([{ kind: "forwarded" }]);
  });
});

describe("local demo keys", () => {
  it("are read from e2e/helpers/local-env.ts, as the CLI's fixed consumer keys", () => {
    const keys = localDemoKeys();
    const source = readFileSync("e2e/helpers/local-env.ts", "utf8");
    expect(source).toContain(`"${keys.anonKey}"`);
    expect(source).toContain(`"${keys.serviceKey}"`);
    expect(keys.anonKey).not.toBe(keys.serviceKey);
  });

  it("fail closed when the source no longer records them", () => {
    expect(() => localDemoKeys("export const nothing = 1;")).toThrow(/were not found/);
  });
});

describe("sign-in", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exchanges GoTrue's magic-link token for the app's session cookie", async () => {
    const calls: string[] = [];
    const access = "header.payload.signature";
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(new URL(url).pathname);
      if (url.endsWith("/auth/v1/admin/generate_link")) {
        return Response.json({ hashed_token: "h", verification_type: "magiclink" });
      }
      if (url.includes("/auth/v1/verify")) {
        return Response.json({
          access_token: access,
          refresh_token: "r",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: "bearer",
          user: { id: "u", aud: "authenticated", email: SEED.email, app_metadata: {}, user_metadata: {}, created_at: "" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const session = await signIn(API, "anon", "service");
    expect(session.error).toBeUndefined();
    // @supabase/ssr names the cookie after the API host's first label.
    expect(session.cookie).toMatch(/^sb-127-auth-token(\.0)?=base64-/);
    expect(calls).toEqual(["/auth/v1/admin/generate_link", "/auth/v1/verify"]);
  });

  it("constructs the client on a runtime WITHOUT a WebSocket (Node 20, as in ci.yml)", async () => {
    // Node 24 has a native WebSocket, so the runner's crash cannot reproduce
    // here unless it is removed first: supabase-js builds a realtime client on
    // construction and refuses to without one.
    vi.stubGlobal("WebSocket", undefined);
    // generate_link must succeed so signIn reaches the client construction.
    vi.stubGlobal("fetch", async (input: string | URL | Request) =>
      String(input instanceof Request ? input.url : input).endsWith("/admin/generate_link")
        ? Response.json({ hashed_token: "h", verification_type: "magiclink" })
        : new Response('{"msg":"nope"}', { status: 400 }),
    );
    const result = await signIn(API, "anon", "service");
    expect(result.error).toMatch(/^verifyOtp: /);
  });

  it("fails as a MISS, not a crash, when the user does not exist (the negative control)", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    expect((await signIn(API, "anon", "service")).error).toMatch(/generate_link answered 404/);
  });
});

describe("restore-drill.sh hook: PASS needs post-restore 0 and pre-restore exactly 1 WITH the check's own MISS line", () => {
  const script = readFileSync("scripts/ops/restore-drill.sh", "utf8");
  const appCheck = script.match(/^app_check\(\) \{.*\}$/m)?.[0];
  const preCase = script.match(/^ {2}case "\$\(app_check pre-restore\)" in .*esac$/m)?.[0];
  const postCase = script.match(/^ {2}case "\$\(app_check post-restore\)" in .*esac$/m)?.[0];
  const gate = script.match(/^ {2}if \[ "\$APP_NEGATIVE" = failed \] && ! grep -q .*; fi$/m)?.[0];

  /** Run the drill's own hook lines against a fake check that prints `text` and exits `exitCode`. */
  function outcome(lines: Array<string | undefined>, exitCode: number, text = ""): string {
    const dir = mkdtempSync(path.join(tmpdir(), "drill-hook-"));
    try {
      const check = path.join(dir, "check");
      writeFileSync(check, `#!/bin/sh\ncat <<'EOF'\n${text}\nEOF\nexit ${exitCode}\n`, { mode: 0o755 });
      const body = [
        "set -euo pipefail",
        `APP_CHECK=${check}; API=x; EVIDENCE=${dir}`,
        appCheck,
        ...lines.map((l) => l!.replace(/APP_NEGATIVE|APP_READ/g, "OUT")),
        'echo "$OUT"',
      ].join("\n");
      return execFileSync("bash", ["-c", body], { encoding: "utf8" }).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // The gate reads the pre-restore log, which the check's stdout lands in.
  const pre = (code: number, text?: string) => outcome([preCase, gate], code, text);

  it("the hook lines exist", () => {
    expect(appCheck).toBeDefined();
    expect(preCase).toBeDefined();
    expect(postCase).toBeDefined();
    expect(gate).toBeDefined();
    expect(script).toMatch(/\[ "\$APP_READ" = passed \] \|\| \{ RESULT=FAIL;/);
    expect(script).toMatch(/\[ "\$APP_NEGATIVE" = failed \] \|\| \{ RESULT=FAIL;/);
  });

  it.each([
    [0, "passed"],
    [1, "failed"],
    [2, "error"],
    [127, "error"],
  ])("post-restore: exit %i maps to %s", (code, expected) => {
    expect(outcome([postCase], code)).toBe(expected);
  });

  it("negative control: exit 1 WITH a MISS line is the only accepted outcome", () => {
    expect(pre(1, "app check MISS: client list: GET /clients answered 307")).toBe("failed");
  });

  it.each([
    ["exit 1 with no MISS line (a crash, sudo or a bad import)", 1, "Error: Node.js 20 detected without native WebSocket support."],
    ["exit 1 with a HARNESS line", 1, "app check HARNESS ERROR: uncaught: boom"],
    ["exit 0 (nothing was missing)", 0, "app check ok"],
    ["exit 2 (a harness error)", 2, "app check HARNESS ERROR: no build"],
  ])("negative control: %s is an error, never a valid control", (_name, code, text) => {
    expect(pre(code, text)).toBe(code === 0 ? "passed" : "error");
  });
});

// A closed environment, so a stray variable from the shell cannot change an exit code.
const CLEAN_ENV = Object.assign(Object.create(null), { PATH: process.env.PATH ?? "" }) as NodeJS.ProcessEnv;

describe("the check never exits 1 for anything but a read MISS", () => {
  const SCRIPT = "scripts/ops/restore-drill-app-check.mjs";
  const API = "http://127.0.0.1:56521";

  /** The real script, copied into a scratch tree so its repo root is the scratch dir. */
  function run(args: string[], stamp?: string): { code: number | null; stderr: string } {
    const root = mkdtempSync(path.join(tmpdir(), "drill-entry-"));
    try {
      mkdirSync(path.join(root, "scripts", "ops"), { recursive: true });
      copyFileSync(SCRIPT, path.join(root, "scripts", "ops", "restore-drill-app-check.mjs"));
      if (stamp !== undefined) {
        mkdirSync(path.join(root, ".next"), { recursive: true });
        writeFileSync(path.join(root, ".next", "restore-drill-app.json"), stamp);
      }
      const r = spawnSync(process.execPath, [path.join(root, "scripts", "ops", "restore-drill-app-check.mjs"), ...args], {
        encoding: "utf8",
        env: CLEAN_ENV,
      });
      return { code: r.status, stderr: r.stderr };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("an UNCAUGHT error (a corrupt build stamp) exits 2 with the error logged", () => {
    const r = run(["post-restore", API, tmpdir()], "{ not json");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/HARNESS ERROR: uncaught: /);
    expect(r.stderr).not.toMatch(/app check MISS/);
  });

  it.each([
    ["no build", ["post-restore", API, tmpdir()], undefined],
    ["a wrong API", ["pre-restore", "https://x.supabase.co", tmpdir()], undefined],
    ["a bad phase", ["bogus"], undefined],
    ["no arguments", [], undefined],
  ])("%s is a harness error (2), not a miss", (_name, args, stamp) => {
    const r = run(args, stamp);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/HARNESS ERROR/);
  });

  it("an error thrown OUTSIDE main() still exits 2, not Node's own 1", () => {
    const root = mkdtempSync(path.join(tmpdir(), "drill-late-"));
    try {
      mkdirSync(path.join(root, "scripts", "ops"), { recursive: true });
      const copy = path.join(root, "scripts", "ops", "restore-drill-app-check.mjs");
      // A throw on a microtask runs before main() returns, outside its try/catch.
      const source = readFileSync(SCRIPT, "utf8");
      const entry = "  process.exit(await main(process.argv.slice(2)));";
      expect(source).toContain(entry);
      writeFileSync(copy, source.replace(entry, `  queueMicrotask(() => { throw new Error("late"); });\n${entry}`));
      const r = spawnSync(process.execPath, [copy, "bogus"], { encoding: "utf8", env: CLEAN_ENV });
      expect(r.status).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
