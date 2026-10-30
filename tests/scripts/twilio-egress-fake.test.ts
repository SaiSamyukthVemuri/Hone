import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// TWILIO-EGRESS-FAKE (MSG-006). Unit-lane proof for
// e2e/helpers/twilio-egress-fake.cjs, the preload that keeps every local
// browser lane away from the real Twilio API. The browser half (the real
// server, a real public booking reaching the SMS send) is
// e2e/twilio-egress-fake.spec.ts. This file proves the fake on every request
// stack, and against the REAL lib/sms/twilio.ts classifier, with no network.
// Everything here runs on the CI Node (20) as well as 24: see the last block.
//
// SAFETY, TWICE OVER: every probe that addresses a Twilio host checks first
// that the fake armed in its own process (exit 90, nothing sent, otherwise),
// and runs with tests/fixtures/twilio-socket-backstop.cjs preloaded UNDERNEATH
// it, which refuses DNS and socket connects to any Twilio host and prints a
// TWILIO_BACKSTOP_HIT line. "Zero real egress" below means zero such lines: the
// request never reached a resolver or a socket.

// The e2e env module refuses, AT IMPORT, any Supabase URL that is not the local
// stack, and the unit lane sets NEXT_PUBLIC_SUPABASE_URL to a hosted-looking
// placeholder on purpose. So it is imported only after those are cleared (the
// same dance as tests/scripts/sentry-egress-guard.test.ts).
let E2E_WEB_SERVER_ENV: Record<string, string>;
let PAYMENT_WEB_SERVER_ENV: Record<string, string>;
let GOOGLE_WEB_SERVER_ENV: Record<string, string>;
let E2E_SENTRY_EGRESS_GUARD: string;
let assertTwilioEgressFakeWired: (env: Record<string, string> | undefined) => void;
let config: typeof import("../../e2e/helpers/twilio-egress-config");

beforeAll(async () => {
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_DB_URL", "HONE_LOCAL_DB_URL", "E2E_SUPABASE_URL"]) {
    vi.stubEnv(name, "");
  }
  ({ E2E_WEB_SERVER_ENV, E2E_SENTRY_EGRESS_GUARD } = await import("../../e2e/helpers/local-env"));
  ({ PAYMENT_WEB_SERVER_ENV } = await import("../../e2e-payment/helpers/payment-env"));
  ({ GOOGLE_WEB_SERVER_ENV } = await import("../../e2e-google/helpers/google-env"));
  ({ assertTwilioEgressFakeWired } = await import("../../e2e/helpers/twilio-egress"));
  config = await import("../../e2e/helpers/twilio-egress-config");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const ROOT = path.resolve(__dirname, "../..");
const FAKE = path.join(ROOT, "e2e", "helpers", "twilio-egress-fake.cjs");
const BACKSTOP = path.join(ROOT, "tests", "fixtures", "twilio-socket-backstop.cjs");
const MESSAGES_URL = "https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Messages.json";

const DEPLOYED_SIGNALS: Array<[string, Record<string, string>]> = [
  ["VERCEL", { VERCEL: "1" }],
  ["VERCEL_ENV", { VERCEL_ENV: "preview" }],
  ["AWS_REGION", { AWS_REGION: "us-east-1" }],
  ["AWS_EXECUTION_ENV", { AWS_EXECUTION_ENV: "AWS_Lambda_nodejs20.x" }],
  ["KUBERNETES_SERVICE_HOST", { KUBERNETES_SERVICE_HOST: "10.0.0.1" }],
];

const INTERLOCK = `
if (!globalThis[Symbol.for("hone.e2e.twilioEgressFake")]?.active) {
  console.log(JSON.stringify({ interlock: "fake not armed; nothing sent" }));
  process.exit(90);
}
`;

type Probe = {
  status: number | null;
  stdout: string;
  stderr: string;
  backstopHits: string[];
  records: Array<Record<string, unknown>>;
  logText: string;
};

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST", "NODE_OPTIONS"]) {
    delete env[key];
  }
  return env;
}

function run(preloads: string[], script: string, extraEnv: Record<string, string> = {}): Probe {
  const dir = mkdtempSync(path.join(os.tmpdir(), "twilio-egress-fake-"));
  const log = path.join(dir, "twilio.jsonl");
  try {
    const res = spawnSync(
      process.execPath,
      [...preloads.flatMap((p) => ["--require", p]), "--no-warnings", "-e", script],
      {
        cwd: ROOT,
        env: {
          ...cleanEnv(),
          HONE_E2E_TWILIO_EGRESS_LOG: log,
          TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
          TWILIO_AUTH_TOKEN: "dummy-twilio-token",
          TWILIO_FROM_NUMBER: "+15555550100",
          ...extraEnv,
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    const logText = existsSync(log) ? readFileSync(log, "utf8") : "";
    return {
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
      backstopHits: res.stderr.split("\n").filter((l) => l.startsWith("TWILIO_BACKSTOP_HIT")),
      records: logText.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
      logText,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const withFake = (script: string, env?: Record<string, string>) => run([BACKSTOP, FAKE], INTERLOCK + script, env);

function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

// The REAL classifier, loaded IN THIS PROCESS through vitest's own TypeScript
// transform: CI runs Node 20, which has neither native type stripping nor
// module.registerHooks, so a child process cannot load lib/sms/twilio.ts
// (Codex P1 on #1117). Vitest's forks pool gives this file its own process, so
// the backstop and the fake installed here never reach another test file.
describe("the REAL lib/sms/twilio.ts reads each scripted outcome as intended", () => {
  let sendSmsSafely: typeof import("@/lib/sms/twilio").sendSmsSafely;
  let logFile: string;
  let logDir: string;
  const hits = () => (globalThis as Record<symbol, string[] | undefined>)[Symbol.for("hone.test.twilioBackstopHits")] ?? [];
  const recordsSince = (offset: number) =>
    (existsSync(logFile) ? readFileSync(logFile, "utf8").slice(offset) : "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const logSize = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0);

  beforeAll(async () => {
    for (const name of ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST", "TWILIO_MESSAGING_SERVICE_SID"]) {
      vi.stubEnv(name, "");
    }
    logDir = mkdtempSync(path.join(os.tmpdir(), "twilio-egress-fake-inproc-"));
    logFile = path.join(logDir, "twilio.jsonl");
    vi.stubEnv("HONE_E2E_TWILIO_EGRESS_LOG", logFile);
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC00000000000000000000000000000000");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "dummy-twilio-token");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15555550100");
    const load = createRequire(__filename);
    load(BACKSTOP); // underneath, exactly as in the child probes
    load(FAKE);
    // Interlock: never call the sender unless the fake armed in this process.
    expect((globalThis as Record<symbol, { active?: boolean } | undefined>)[Symbol.for("hone.e2e.twilioEgressFake")]?.active).toBe(true);
    ({ sendSmsSafely } = await import("@/lib/sms/twilio"));
  });

  afterAll(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  it("DEFAULT: a refusal before connecting is twilio_unreachable, retryable, attempt 'refused' (a definite non-send)", async () => {
    const from = logSize();
    expect(await sendSmsSafely({ to: "+16045550199", body: "probe" })).toEqual({
      ok: false,
      error: "twilio_unreachable",
      retryable: true,
      attempt: "refused",
    });
    expect(hits()).toEqual([]);
    expect(recordsSince(from)).toEqual([
      expect.objectContaining({
        kind: "message",
        via: "fetch",
        host: "api.twilio.com",
        path: "/2010-04-01/Accounts/{sid}/Messages.json",
        mode: "refuse",
        toLast4: "0199",
      }),
    ]);
  });

  it("...0153: a 503 is retryable but 'ambiguous' (the control: the message may exist)", async () => {
    const from = logSize();
    expect(await sendSmsSafely({ to: `+1604555${config.TWILIO_FAKE_AMBIGUOUS_503_LAST4}`, body: "probe" })).toMatchObject({
      ok: false,
      error: "twilio_http_503",
      retryable: true,
      attempt: "ambiguous",
    });
    expect(hits()).toEqual([]);
    expect(recordsSince(from)).toEqual([expect.objectContaining({ mode: "ambiguous_503", toLast4: "0153" })]);
  });

  it("...0150: accepted, with a well-formed message SID", async () => {
    const from = logSize();
    expect(await sendSmsSafely({ to: `+1604555${config.TWILIO_FAKE_ACCEPT_LAST4}`, body: "probe" })).toEqual({
      ok: true,
      messageSid: expect.stringMatching(/^SM[0-9a-f]{32}$/),
    });
    expect(hits()).toEqual([]);
    expect(recordsSince(from)).toEqual([expect.objectContaining({ mode: "accept", toLast4: "0150" })]);
  });
});

describe("every request stack to a Twilio host is answered or refused locally: zero real egress", () => {
  it("fetch to a non-Messages Twilio URL is refused (ECONNREFUSED), never connected", () => {
    const p = withFake(`
fetch("https://lookups.twilio.com/v2/PhoneNumbers/x").then(
  () => console.log(JSON.stringify({ outcome: "resolved" })),
  (e) => console.log(JSON.stringify({ outcome: "rejected", name: e.name, code: e.cause && e.cause.code })),
);`);
    expect(p.status, p.stderr).toBe(0);
    expect(lastJson(p.stdout)).toEqual({ outcome: "rejected", name: "TypeError", code: "ECONNREFUSED" });
    expect(p.backstopHits).toEqual([]);
    expect(p.records).toEqual([expect.objectContaining({ kind: "refused", via: "fetch", host: "lookups.twilio.com", mode: "refuse" })]);
  });

  it.each(["https.request", "https.get", "http.request"] as const)("%s is refused before connecting", (via) => {
    const [mod, fn] = via.split(".");
    const p = withFake(`
const req = require("node:${mod}").${fn}(${JSON.stringify(MESSAGES_URL.replace("https:", `${mod}:`))}, { method: "POST" });
req.on("error", (e) => console.log(JSON.stringify({ outcome: "error", code: e.code })));
req.on("response", () => console.log(JSON.stringify({ outcome: "response" })));
${fn === "request" ? "req.end('To=%2B16045550199');" : ""}`);
    expect(p.status, p.stderr).toBe(0);
    expect(lastJson(p.stdout)).toEqual({ outcome: "error", code: "ECONNREFUSED" });
    expect(p.backstopHits).toEqual([]);
    expect(p.records).toEqual([expect.objectContaining({ kind: "refused", via, host: "api.twilio.com" })]);
  });

  it.each([
    ["tls.connect", `require("node:tls").connect({ host: "api.twilio.com", port: 443, servername: "api.twilio.com" })`],
    ["net.connect", `require("node:net").connect(443, "api.twilio.com")`],
  ])("raw %s is refused, never connected", (via, call) => {
    const p = withFake(`
const s = ${call};
s.on("error", (e) => console.log(JSON.stringify({ outcome: "error", code: e.code })));
s.on("connect", () => console.log(JSON.stringify({ outcome: "connected" })));`);
    expect(p.status, p.stderr).toBe(0);
    expect(lastJson(p.stdout)).toEqual({ outcome: "error", code: "ECONNREFUSED" });
    expect(p.backstopHits).toEqual([]);
    expect(p.records).toEqual([expect.objectContaining({ kind: "refused", via, host: "api.twilio.com" })]);
  });

  it("a host that merely CONTAINS twilio.com is not Twilio, and passes through untouched", () => {
    const p = withFake(`
const http = require("node:http");
const server = http.createServer((q, r) => r.end("local")).listen(0, "127.0.0.1", async () => {
  const res = await fetch("http://127.0.0.1:" + server.address().port + "/twilio.com/Messages.json");
  console.log(JSON.stringify({ outcome: await res.text() }));
  server.close();
});`);
    expect(p.status, p.stderr).toBe(0);
    expect(lastJson(p.stdout)).toEqual({ outcome: "local" });
    expect(p.records).toEqual([]);
  });

  it("records never carry the message body or the full destination number", () => {
    const p = withFake(`
fetch(${JSON.stringify(MESSAGES_URL)}, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ To: "+16045550177", Body: "Reminder PRIVATE_NAME https://example.invalid/manage/SECRET_TOKEN" }).toString(),
}).catch(() => console.log(JSON.stringify({ outcome: "refused" })));`);
    expect(p.status, p.stderr).toBe(0);
    expect(p.records).toEqual([expect.objectContaining({ mode: "refuse", toLast4: "0177" })]);
    for (const secret of ["16045550177", "6045550177", "PRIVATE_NAME", "SECRET_TOKEN", "AC00000000000000000000000000000000"]) {
      expect(p.logText).not.toContain(secret);
    }
  });
});

describe("the backstop would catch a broken fake (negative control, never a real call)", () => {
  it("WITHOUT the fake, a fetch to api.twilio.com reaches the backstop's socket refusal", () => {
    const p = run([BACKSTOP], `
fetch(${JSON.stringify(MESSAGES_URL)}, { method: "POST", body: "To=%2B16045550199" }).then(
  () => console.log(JSON.stringify({ outcome: "resolved" })),
  (e) => console.log(JSON.stringify({ outcome: "rejected", code: e.cause && e.cause.code })),
);`);
    expect(p.status, p.stderr).toBe(0);
    expect(lastJson(p.stdout)).toEqual({ outcome: "rejected", code: "ENOTFOUND" });
    expect(p.backstopHits.length).toBeGreaterThan(0);
    expect(p.records).toEqual([]);
  });

  it("an unarmed fake trips the interlock and sends nothing", () => {
    const p = run([BACKSTOP], INTERLOCK + `fetch(${JSON.stringify(MESSAGES_URL)});`);
    expect(p.status).toBe(90);
    expect(p.backstopHits).toEqual([]);
  });
});

describe("a deployed-runtime signal refuses to start", () => {
  it.each(DEPLOYED_SIGNALS)("%s", (_name, env) => {
    const p = run([FAKE], `console.log("started")`, env);
    expect(p.status).not.toBe(0);
    expect(p.stdout).not.toContain("started");
    expect(p.stderr).toContain("[twilio-egress-fake] REFUSING TO START");
  });

  it("the deployed-signal list is the SAME set as the Sentry egress guard's", () => {
    const names = (file: string) => {
      const src = readFileSync(file, "utf8");
      const body = src.slice(src.indexOf("function deployedEnvironmentSignal"));
      return [...body.slice(0, body.indexOf("\n}\n")).matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]).sort();
    };
    const guard = names(path.join(ROOT, "e2e", "helpers", "sentry-egress-guard.cjs"));
    expect(guard.length).toBeGreaterThan(0);
    expect(names(FAKE)).toEqual(guard);
  });
});

describe("every browser lane loads it, and nothing deployed can", () => {
  it("the scripted last-four constants match the preload's", () => {
    const src = readFileSync(FAKE, "utf8");
    expect(src).toContain(`const AMBIGUOUS_503_SUFFIX = "${config.TWILIO_FAKE_AMBIGUOUS_503_LAST4}";`);
    expect(src).toContain(`const ACCEPT_SUFFIX = "${config.TWILIO_FAKE_ACCEPT_LAST4}";`);
  });

  it("the lane env carries the fake beside the Sentry guard, and its record path", () => {
    expect(config.E2E_TWILIO_EGRESS_FAKE).toBe(FAKE);
    expect(E2E_WEB_SERVER_ENV.NODE_OPTIONS).toContain(`--import ${FAKE}`);
    expect(E2E_WEB_SERVER_ENV.NODE_OPTIONS).toContain(`--require ${E2E_SENTRY_EGRESS_GUARD}`);
    expect(path.isAbsolute(E2E_WEB_SERVER_ENV.HONE_E2E_TWILIO_EGRESS_LOG)).toBe(true);
  });

  it("the payment, mobile and Google lanes inherit it (they spread the core env)", () => {
    for (const env of [PAYMENT_WEB_SERVER_ENV, GOOGLE_WEB_SERVER_ENV]) {
      expect(env.NODE_OPTIONS).toBe(E2E_WEB_SERVER_ENV.NODE_OPTIONS);
      expect(env.HONE_E2E_TWILIO_EGRESS_LOG).toBe(E2E_WEB_SERVER_ENV.HONE_E2E_TWILIO_EGRESS_LOG);
    }
  });

  it("globalSetup refuses a lane whose server env lost the fake", () => {
    for (const env of [E2E_WEB_SERVER_ENV, PAYMENT_WEB_SERVER_ENV, GOOGLE_WEB_SERVER_ENV]) {
      expect(() => assertTwilioEgressFakeWired(env)).not.toThrow();
    }
    expect(() => assertTwilioEgressFakeWired(undefined)).toThrow(/NOT WIRED/);
    expect(() => assertTwilioEgressFakeWired({ ...E2E_WEB_SERVER_ENV, NODE_OPTIONS: "--max-old-space-size=4096" })).toThrow(/NOT WIRED/);
    expect(() => assertTwilioEgressFakeWired({ ...E2E_WEB_SERVER_ENV, HONE_E2E_TWILIO_EGRESS_LOG: "" })).toThrow(/NOT WIRED/);
    const setup = readFileSync(path.join(ROOT, "e2e", "global-setup.ts"), "utf8");
    const body = setup.slice(setup.indexOf("export default async function globalSetup"));
    expect(body).toContain("assertTwilioEgressFakeWired(config.webServer?.env);");
    expect(body.indexOf("assertTwilioEgressFakeWired")).toBeLessThan(body.indexOf("runSchemaPreflight"));
  });

  it("composes with existing NODE_OPTIONS instead of replacing them, once", () => {
    expect(config.withTwilioEgressFake(undefined)).toBe(`--import ${FAKE}`);
    expect(config.withTwilioEgressFake("--max-old-space-size=4096")).toBe(`--max-old-space-size=4096 --import ${FAKE}`);
    const once = config.withTwilioEgressFake("--max-old-space-size=4096");
    expect(config.withTwilioEgressFake(once)).toBe(once);
  });

  it("is referenced by the e2e harness alone: no build, start or runtime path names it", () => {
    const productionInputs = [
      "next.config.ts",
      "instrumentation.ts",
      "instrumentation-client.ts",
      "middleware.ts",
      "package.json",
      "lib/sms/twilio.ts",
      ...(existsSync(path.join(ROOT, "vercel.json")) ? ["vercel.json"] : []),
    ];
    for (const rel of productionInputs) {
      expect(readFileSync(path.join(ROOT, rel), "utf8"), rel).not.toContain("twilio-egress-fake");
    }
  });
});

describe("runs on CI's Node, and survives Next's NODE_OPTIONS re-formatting (#1117 run 40140137937)", () => {
  const GUARD = path.join(ROOT, "e2e", "helpers", "sentry-egress-guard.cjs");

  function withNodeOptions<T>(value: string, fn: () => T): T {
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = value;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  }

  // Next's own function, the one its build and render workers are spawned with.
  async function nextWorkerNodeOptions(value: string): Promise<string> {
    const utils = (await import("next/dist/server/lib/utils")) as unknown as {
      getFormattedNodeOptionsWithoutInspect: () => string;
    };
    return withNodeOptions(value, () => utils.getFormattedNodeOptionsWithoutInspect());
  }

  it("CI pins patched Node 24 (CVE-2026-111497), and on CI this suite runs on that Node", () => {
    const pinned = new Set(
      [...readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8").matchAll(/node-version:\s*"?(\d+)/g)].map((m) => m[1]),
    );
    expect([...pinned]).toEqual(["24"]);
    if (process.env.GITHUB_ACTIONS === "true") {
      expect(process.versions.node.split(".")[0]).toBe("24");
    }
  });

  it("the preload, its config and the backstop use no API newer than Node 20", () => {
    const NEWER_THAN_20 =
      /registerHooks|getBuiltinModule|stripTypeScriptTypes|experimental-strip-types|import\.meta\.(dirname|filename)|process\.features\.typescript/;
    for (const file of [FAKE, BACKSTOP, path.join(ROOT, "e2e", "helpers", "twilio-egress-config.ts")]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(NEWER_THAN_20);
    }
  });

  it("two --require entries are merged by Next into ONE bogus path (the trap the lane fell into)", async () => {
    const merged = await nextWorkerNodeOptions(`--require ${GUARD} --require ${FAKE}`);
    expect(merged).toContain(`${GUARD} ${FAKE}`);
  });

  it("the lane's NODE_OPTIONS keeps the guard and the fake as SEPARATE preloads through Next", async () => {
    const formatted = await nextWorkerNodeOptions(E2E_WEB_SERVER_ENV.NODE_OPTIONS);
    expect(formatted).toContain(`--require=${GUARD}`);
    expect(formatted).toContain(`--import=${FAKE}`);
  });

  it("a worker started with Next's re-formatted options arms BOTH preloads on this Node", async () => {
    const formatted = await nextWorkerNodeOptions(E2E_WEB_SERVER_ENV.NODE_OPTIONS);
    const dir = mkdtempSync(path.join(os.tmpdir(), "twilio-egress-worker-"));
    try {
      const res = spawnSync(
        process.execPath,
        [
          "-e",
          `console.log(JSON.stringify({
            sentry: !!globalThis[Symbol.for("hone.e2e.sentryEgressGuard")]?.active,
            twilio: !!globalThis[Symbol.for("hone.e2e.twilioEgressFake")]?.active,
          }))`,
        ],
        {
          cwd: ROOT,
          env: {
            ...cleanEnv(),
            NODE_OPTIONS: formatted,
            HONE_E2E_SENTRY_EGRESS_LOG: path.join(dir, "sentry.jsonl"),
            HONE_E2E_TWILIO_EGRESS_LOG: path.join(dir, "twilio.jsonl"),
          },
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      expect(res.status, res.stderr).toBe(0);
      expect(lastJson(res.stdout)).toEqual({ sentry: true, twilio: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
