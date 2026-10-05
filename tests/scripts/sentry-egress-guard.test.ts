import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  E2E_SENTRY_EGRESS_GUARD,
  E2E_SENTRY_EGRESS_LOG,
  E2E_WEB_SERVER_ENV,
  withSentryEgressGuard,
} from "../../e2e/helpers/local-env";
import { PAYMENT_WEB_SERVER_ENV } from "../../e2e-payment/helpers/payment-env";
import { GOOGLE_WEB_SERVER_ENV } from "../../e2e-google/helpers/google-env";
import { formatSentryEgressReport, type EgressRecord } from "../../e2e/helpers/sentry-egress";

// SENTRY-E2E-NOISE-02. Unit-lane proof for e2e/helpers/sentry-egress-guard.cjs,
// the preload that keeps every local browser lane out of the operational Sentry
// project. The browser half - the real server, the real SDK, the real tunnel -
// is proved in e2e/authenticated-route-error-containment.spec.ts. This file
// proves the guard itself on every request stack, with no network.
//
// SAFETY, TWICE OVER, because a broken guard must fail this suite rather than
// reach sentry.io from it:
//   * every probe that addresses a Sentry host first checks that the guard
//     armed in its own process, and exits 90 WITHOUT sending otherwise;
//   * every probe runs with tests/fixtures/sentry-dns-backstop.cjs preloaded
//     UNDERNEATH the guard, which refuses to resolve any Sentry host. An armed
//     guard whose patch is wrong (reverted, or matching the wrong host) then
//     fails with the backstop's resolution error, never with a sent request.

const ROOT = path.resolve(__dirname, "../..");
const GUARD = path.join(ROOT, "e2e", "helpers", "sentry-egress-guard.cjs");
const BACKSTOP = path.join(ROOT, "tests", "fixtures", "sentry-dns-backstop.cjs");

// The production DSN's own hosts, exactly as the SDKs derive them.
const INGEST_HOST = "o4511758551941120.ingest.us.sentry.io";
const ENVELOPE_PATH = "/api/4511758557839360/envelope/";
const DSN = `https://83582fd24c2d75b0a2ada024251147bc@${INGEST_HOST}/4511758557839360`;

const DEPLOYED_SIGNALS: Array<[string, Record<string, string>]> = [
  ["VERCEL", { VERCEL: "1" }],
  ["VERCEL_ENV", { VERCEL_ENV: "preview" }],
  ["AWS_REGION", { AWS_REGION: "us-east-1" }],
  ["AWS_EXECUTION_ENV", { AWS_EXECUTION_ENV: "AWS_Lambda_nodejs20.x" }],
  ["KUBERNETES_SERVICE_HOST", { KUBERNETES_SERVICE_HOST: "10.0.0.1" }],
];

const INTERLOCK = `
if (!globalThis[Symbol.for("hone.e2e.sentryEgressGuard")]?.active) {
  console.log(JSON.stringify({ interlock: "guard not armed; nothing sent" }));
  process.exit(90);
}
`;

const ENVELOPE = [
  JSON.stringify({ event_id: "a".repeat(32), dsn: DSN }),
  JSON.stringify({ type: "event" }),
  JSON.stringify({
    event_id: "a".repeat(32),
    platform: "node",
    exception: { values: [{ type: "Error", value: "guard probe", mechanism: { type: "generic", handled: true } }] },
  }),
].join("\n");

type Probe = { status: number | null; stdout: string; stderr: string; records: Array<Record<string, unknown>> };

function inheritedEnvWithoutDeployedSignals(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST", "NODE_OPTIONS"]) {
    delete env[key];
  }
  return env;
}

function runWithGuard(script: string, extraEnv: Record<string, string> = {}): Probe {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sentry-egress-guard-"));
  const log = path.join(dir, "egress.jsonl");
  try {
    const res = spawnSync(process.execPath, ["--require", BACKSTOP, "--require", GUARD, "-e", script], {
      cwd: ROOT,
      env: { ...inheritedEnvWithoutDeployedSignals(), HONE_E2E_SENTRY_EGRESS_LOG: log, ...extraEnv },
      encoding: "utf8",
      timeout: 60_000,
    });
    const records = existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, records };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runWithBackstopOnly(script: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ["--require", BACKSTOP, "-e", script], {
    cwd: ROOT,
    env: inheritedEnvWithoutDeployedSignals(),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

type EnvelopeRecord = {
  kind: string;
  via: string;
  host: string;
  items: Array<{ type: string; platform?: string; exceptions?: Array<{ value?: string }> }>;
};

function envelopes(probe: Probe): EnvelopeRecord[] {
  return probe.records.filter((r) => r.kind === "envelope") as unknown as EnvelopeRecord[];
}

describe("this suite's own backstop really stops every stack (so a broken guard cannot leak)", () => {
  // Run WITHOUT the guard, against a name that does not exist: if the backstop
  // failed, the system resolver would answer NXDOMAIN and no request could be
  // made either, so this check is itself incapable of reaching Sentry.
  const host = "hone-backstop-check.sentry.io";

  it.each([
    ["node:https.request", `require("node:https").request({ hostname: "${host}", path: "/" }).on("error", (e) => report(e)).end()`],
    ["global fetch", `fetch("https://${host}/").catch((e) => report(e.cause ?? e))`],
    ["Next's edge-runtime fetch", `require("next/dist/compiled/@edge-runtime/primitives/fetch.js").fetch("https://${host}/").catch((e) => report(e.cause ?? e))`],
    ["tls.connect", `require("node:tls").connect(443, "${host}").on("error", (e) => report(e))`],
  ])("%s", (_label, call) => {
    const probe = runWithBackstopOnly(`
      const report = (e) => console.log(JSON.stringify({ backstopped: String(e && e.message).includes("sentry dns backstop") }));
      ${call};
    `);
    expect(probe.status, probe.stderr).toBe(0);
    expect(lastJson(probe.stdout)).toEqual({ backstopped: true });
  });
});

describe("a Sentry-bound request is answered locally and recorded, on every request stack", () => {
  it("node:https.request (the server SDK's transport and the tunnel's proxy)", () => {
    const probe = runWithGuard(`${INTERLOCK}
      const req = require("node:https").request(
        { hostname: ${JSON.stringify(INGEST_HOST)}, path: ${JSON.stringify(ENVELOPE_PATH)}, method: "POST" },
        (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => console.log(JSON.stringify({ status: res.statusCode, body: d }))); },
      );
      req.on("error", (e) => console.log(JSON.stringify({ error: e.message })));
      req.end(${JSON.stringify(ENVELOPE)});
    `);

    expect(probe.status, probe.stderr).toBe(0);
    expect(lastJson(probe.stdout)).toEqual({ status: 200, body: JSON.stringify({ id: "a".repeat(32) }) });
    const [rec] = envelopes(probe);
    expect(rec).toMatchObject({ via: "https.request", host: INGEST_HOST });
    expect(rec.items[0]).toMatchObject({ type: "event", platform: "node" });
    expect(rec.items[0].exceptions?.[0]?.value).toBe("guard probe");
  });

  it("the REAL @sentry/node SDK, initialised with the production DSN", () => {
    const probe = runWithGuard(`${INTERLOCK}
      const Sentry = require("@sentry/node");
      Sentry.init({ dsn: ${JSON.stringify(DSN)}, tracesSampleRate: 0 });
      Sentry.captureException(new Error("real sdk probe"));
      Sentry.flush(10000).then((ok) => console.log(JSON.stringify({ flushed: ok })));
    `);

    expect(probe.status, probe.stderr).toBe(0);
    expect(lastJson(probe.stdout)).toEqual({ flushed: true });
    const errors = envelopes(probe).filter((r) => r.items.some((i) => i.type === "event"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ via: "https.request", host: INGEST_HOST });
    expect(errors[0].items[0].exceptions?.[0]?.value).toBe("real sdk probe");
  });

  it("global fetch (undici), a stack the https patch does not touch", () => {
    const probe = runWithGuard(`${INTERLOCK}
      fetch("https://" + ${JSON.stringify(INGEST_HOST)} + ${JSON.stringify(ENVELOPE_PATH)}, { method: "POST", body: ${JSON.stringify(ENVELOPE)} })
        .then(async (res) => console.log(JSON.stringify({ status: res.status, body: await res.text() })))
        .catch((e) => console.log(JSON.stringify({ error: e.message })));
    `);

    expect(probe.status, probe.stderr).toBe(0);
    expect(lastJson(probe.stdout)).toEqual({ status: 200, body: JSON.stringify({ id: "a".repeat(32) }) });
    expect(envelopes(probe)[0]).toMatchObject({ via: "fetch", host: INGEST_HOST });
  });

  it("Next's own tunnel proxy (proxyRequest), the path /monitoring takes in next start", () => {
    // The browser never reaches Sentry itself: it posts to the same-origin
    // /monitoring rewrite, and THIS function forwards it. Driving it directly
    // proves the guard catches the browser's events where they actually leave.
    const probe = runWithGuard(`${INTERLOCK}
      const http = require("node:http");
      const url = require("node:url");
      const { proxyRequest } = require("next/dist/server/lib/router-utils/proxy-request");
      const destination = "https://" + ${JSON.stringify(INGEST_HOST)} + ${JSON.stringify(ENVELOPE_PATH)} + "?hsts=0";
      const server = http.createServer((req, res) => {
        proxyRequest(req, res, url.parse(destination, true), undefined, undefined, 30000).catch((e) => {
          console.log(JSON.stringify({ proxyError: e.message }));
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        const req = http.request(
          { host: "127.0.0.1", port, path: "/monitoring?o=4511758551941120&p=4511758557839360&r=us", method: "POST",
            headers: { "content-type": "text/plain;charset=UTF-8", "user-agent": "probe-browser" } },
          (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { console.log(JSON.stringify({ status: res.statusCode, body: d })); server.close(); }); },
        );
        req.end(${JSON.stringify(ENVELOPE)});
      });
    `);

    expect(probe.status, probe.stderr).toBe(0);
    expect(lastJson(probe.stdout)).toEqual({ status: 200, body: JSON.stringify({ id: "a".repeat(32) }) });
    const [rec] = envelopes(probe);
    expect(rec).toMatchObject({ via: "https.request", host: INGEST_HOST });
    expect(rec.items[0]).toMatchObject({ type: "event" });
  });
});

describe("what it records stays private to the user running the lane", () => {
  it("creates its directory 0700 and its record file 0600, with the sink socket inside", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "sentry-egress-guard-"));
    const dir = path.join(parent, "egress");
    const log = path.join(dir, "egress.jsonl");
    try {
      const res = spawnSync(
        process.execPath,
        [
          "--require",
          BACKSTOP,
          "--require",
          GUARD,
          "-e",
          `${INTERLOCK}
          const req = require("node:https").request(
            { hostname: ${JSON.stringify(INGEST_HOST)}, path: ${JSON.stringify(ENVELOPE_PATH)}, method: "POST" },
            (res) => { res.resume(); res.on("end", () => {
              const sockets = require("node:fs").readdirSync(${JSON.stringify(dir)}).filter((f) => f.endsWith(".sock"));
              console.log(JSON.stringify({ status: res.statusCode, sockets: sockets.length }));
            }); },
          );
          req.end(${JSON.stringify(ENVELOPE)});`,
        ],
        {
          cwd: ROOT,
          env: { ...inheritedEnvWithoutDeployedSignals(), HONE_E2E_SENTRY_EGRESS_LOG: log },
          encoding: "utf8",
          timeout: 60_000,
        },
      );

      expect(res.status, res.stderr).toBe(0);
      expect(lastJson(res.stdout)).toEqual({ status: 200, sockets: 1 });
      expect(statSync(dir).mode.toString(8).slice(-3)).toBe("700");
      expect(statSync(log).mode.toString(8).slice(-3)).toBe("600");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("a raw connection to a Sentry host is refused and recorded", () => {
  it("Next's edge-runtime fetch (its own bundled undici, used by middleware)", () => {
    // Reaches neither the https export nor the global fetch: it opens its socket
    // through tls.connect. Without the connect-level refusal an edge-runtime
    // Sentry event from this lane would still reach the operational project.
    const probe = runWithGuard(`${INTERLOCK}
      const { fetch: edgeFetch } = require("next/dist/compiled/@edge-runtime/primitives/fetch.js");
      edgeFetch("https://" + ${JSON.stringify(INGEST_HOST)} + ${JSON.stringify(ENVELOPE_PATH)}, { method: "POST", body: "x" })
        .then((res) => console.log(JSON.stringify({ reached: res.status })))
        .catch(() => console.log(JSON.stringify({ refused: true })));
    `);

    expect(probe.status, probe.stderr).toBe(0);
    expect(lastJson(probe.stdout)).toEqual({ refused: true });
    expect(probe.records).toContainEqual(
      expect.objectContaining({ kind: "refused", via: "tls.connect", host: INGEST_HOST }),
    );
  });

  it.each([
    ["tls.connect(options)", `require("node:tls").connect({ host: ${JSON.stringify(INGEST_HOST)}, port: 443, servername: ${JSON.stringify(INGEST_HOST)} })`, "tls.connect"],
    ["tls.connect(port, host)", `require("node:tls").connect(443, ${JSON.stringify(INGEST_HOST)})`, "tls.connect"],
    ["net.connect(options)", `require("node:net").connect({ host: ${JSON.stringify(INGEST_HOST)}, port: 443 })`, "net.connect"],
    ["net.createConnection(port, host)", `require("node:net").createConnection(443, ${JSON.stringify(INGEST_HOST.toUpperCase())})`, "net.connect"],
  ])("%s", (_label, call, via) => {
    const probe = runWithGuard(`${INTERLOCK}
      const socket = ${call};
      socket.on("error", (e) => console.log(JSON.stringify({ code: e.code })));
      socket.on("connect", () => console.log(JSON.stringify({ connected: true })));
      socket.on("secureConnect", () => console.log(JSON.stringify({ connected: true })));
    `);

    expect(probe.status, probe.stderr).toBe(0);
    expect(lastJson(probe.stdout)).toEqual({ code: "ECONNREFUSED" });
    expect(probe.records).toContainEqual(
      expect.objectContaining({ kind: "refused", via, host: INGEST_HOST }),
    );
  });

  it("a refused socket with no error listener closes instead of crashing the process", () => {
    const probe = runWithGuard(`${INTERLOCK}
      const socket = require("node:tls").connect(443, ${JSON.stringify(INGEST_HOST)});
      socket.on("close", () => console.log(JSON.stringify({ closed: true })));
    `);

    expect(probe.status, probe.stderr).toBe(0);
    expect(lastJson(probe.stdout)).toEqual({ closed: true });
  });
});

describe("everything else is untouched", () => {
  it("loopback requests on every stack pass straight through, unrecorded", () => {
    const probe = runWithGuard(`${INTERLOCK}
      const http = require("node:http");
      const server = http.createServer((req, res) => res.end("local:" + req.url));
      server.listen(0, "127.0.0.1", async () => {
        const { port } = server.address();
        const viaHttp = await new Promise((resolve) => {
          http.get({ host: "127.0.0.1", port, path: "/a" }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d)); });
        });
        const viaFetch = await (await fetch("http://127.0.0.1:" + port + "/b")).text();
        const viaNet = await new Promise((resolve) => {
          const s = require("node:net").connect(port, "127.0.0.1", () => { s.end(); resolve("connected"); });
        });
        server.close();
        console.log(JSON.stringify({ viaHttp, viaFetch, viaNet }));
      });
    `);

    expect(probe.status, probe.stderr).toBe(0);
    expect(lastJson(probe.stdout)).toEqual({ viaHttp: "local:/a", viaFetch: "local:/b", viaNet: "connected" });
    expect(probe.records).toEqual([]);
  });

  it("a host that merely CONTAINS sentry.io is not treated as Sentry", () => {
    // It must reach the ORIGINAL connect untouched - which is why it fails
    // inside the caller's own lookup below, and so no refusal is recorded. The
    // lookup is supplied so this never queries a resolver.
    const probe = runWithGuard(`${INTERLOCK}
      const s = require("node:net").connect({
        host: "sentry.io.example.test",
        port: 9,
        lookup: (_host, _opts, cb) => cb(Object.assign(new Error("reached the original connect"), { code: "EPROBE" })),
      });
      s.on("error", (e) => console.log(JSON.stringify({ code: e.code })));
    `);

    expect(probe.status, probe.stderr).toBe(0);
    expect(lastJson(probe.stdout)).toEqual({ code: "EPROBE" });
    expect(probe.records.filter((r) => r.kind === "refused")).toEqual([]);
  });
});

describe("fails open in any deployed runtime", () => {
  it.each(DEPLOYED_SIGNALS)("%s: installs nothing and says so", (_label, signal) => {
    // Nothing is sent here, by construction: the probe only inspects whether
    // the request functions were replaced.
    const probe = runWithGuard(
      `
      const state = globalThis[Symbol.for("hone.e2e.sentryEgressGuard")];
      console.log(JSON.stringify({
        active: state?.active ?? null,
        httpsPatched: require("node:https").request.name === "guardedRequest",
        tlsPatched: require("node:tls").connect.name === "guardedTlsConnect",
        fetchPatched: globalThis.fetch.name === "guardedFetch",
      }));
    `,
      signal,
    );

    expect(probe.status, probe.stderr).toBe(0);
    expect(lastJson(probe.stdout)).toEqual({
      active: false,
      httpsPatched: false,
      tlsPatched: false,
      fetchPatched: false,
    });
    expect(probe.stderr).toContain("[sentry-egress-guard] NOT ACTIVE");
  });

  it("arms in the local lane (the negative control for the cases above)", () => {
    const probe = runWithGuard(`
      console.log(JSON.stringify({
        active: globalThis[Symbol.for("hone.e2e.sentryEgressGuard")]?.active ?? null,
        httpsPatched: require("node:https").request.name === "guardedRequest",
      }));
    `);

    expect(lastJson(probe.stdout)).toEqual({ active: true, httpsPatched: true });
  });

  it("the deployed-signal list is the SAME set as the route-fault harness's", () => {
    // The guard cannot import lib/reliability/e2e-route-fault.ts (TypeScript,
    // server-only), so it carries a copy. A copy that silently missed a signal
    // was caught once already (#784); this holds the two to one set.
    const envNames = (src: string, fn: string): string[] => {
      const start = src.indexOf(`function ${fn}`);
      const body = src.slice(start, src.indexOf("\n}", start));
      return [...new Set([...body.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]))].sort();
    };
    const harness = envNames(
      readFileSync(path.join(ROOT, "lib/reliability/e2e-route-fault.ts"), "utf8"),
      "deployedEnvironmentSignal",
    );
    const guard = envNames(readFileSync(GUARD, "utf8"), "deployedEnvironmentSignal");

    expect(harness.length).toBeGreaterThan(0);
    expect(guard).toEqual(harness);
    expect(DEPLOYED_SIGNALS.flatMap(([, s]) => Object.keys(s)).sort()).toEqual(harness);
  });
});

describe("a genuine error raised during a run stays visible in the lane's own log", () => {
  it("the run-end report counts what was held and lists every error event", () => {
    const t = new Date().toISOString();
    const records: EgressRecord[] = [
      { t, pid: 1, kind: "envelope", items: [{ type: "session" }] },
      {
        t,
        pid: 1,
        kind: "envelope",
        items: [{ type: "event", platform: "node", exceptions: [{ value: 'Route /x used "cookies" inside "after(...)"' }] }],
      },
      {
        t,
        pid: 1,
        kind: "envelope",
        items: [{ type: "event", platform: "node", exceptions: [{ value: 'Route /x used "cookies" inside "after(...)"' }] }],
      },
      { t, pid: 1, kind: "envelope", items: [{ type: "event", platform: "javascript", message: "boom" }] },
      { t, pid: 1, kind: "refused", via: "tls.connect", host: INGEST_HOST },
    ];

    expect(formatSentryEgressReport(records)).toEqual([
      "[sentry egress guard] held 4 envelope(s) bound for Sentry and refused 1 raw connection(s) to it during this run.",
      "[sentry egress guard] 3 error event(s) were raised during the run:",
      '    2 x node: Route /x used "cookies" inside "after(...)"',
      "    1 x javascript: boom",
    ]);
  });

  it("a quiet run reports one line and no error list", () => {
    expect(formatSentryEgressReport([])).toEqual([
      "[sentry egress guard] held 0 envelope(s) bound for Sentry and refused 0 raw connection(s) to it during this run.",
    ]);
  });
});

describe("every browser lane loads it, and nothing deployed can", () => {
  it("the lane env carries the guard and its record path", () => {
    expect(E2E_SENTRY_EGRESS_GUARD).toBe(GUARD);
    expect(existsSync(E2E_SENTRY_EGRESS_GUARD)).toBe(true);
    expect(E2E_WEB_SERVER_ENV.NODE_OPTIONS).toContain(`--require ${GUARD}`);
    expect(E2E_WEB_SERVER_ENV.HONE_E2E_SENTRY_EGRESS_LOG).toBe(E2E_SENTRY_EGRESS_LOG);
    expect(path.isAbsolute(E2E_SENTRY_EGRESS_LOG)).toBe(true);
  });

  it("the payment, mobile and Google lanes inherit it (they spread the core env)", () => {
    for (const env of [PAYMENT_WEB_SERVER_ENV, GOOGLE_WEB_SERVER_ENV]) {
      expect(env.NODE_OPTIONS).toBe(E2E_WEB_SERVER_ENV.NODE_OPTIONS);
      expect(env.HONE_E2E_SENTRY_EGRESS_LOG).toBe(E2E_SENTRY_EGRESS_LOG);
    }
  });

  it("composes with existing NODE_OPTIONS instead of replacing them, once", () => {
    expect(withSentryEgressGuard(undefined)).toBe(`--require ${GUARD}`);
    expect(withSentryEgressGuard("  ")).toBe(`--require ${GUARD}`);
    expect(withSentryEgressGuard("--max-old-space-size=4096")).toBe(
      `--max-old-space-size=4096 --require ${GUARD}`,
    );
    const once = withSentryEgressGuard("--max-old-space-size=4096");
    expect(withSentryEgressGuard(once)).toBe(once);
  });

  it("is referenced by the e2e harness alone: no build, start or runtime path names it", () => {
    const productionInputs = [
      "next.config.ts",
      "instrumentation.ts",
      "instrumentation-client.ts",
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
      "middleware.ts",
      "package.json",
      ...(existsSync(path.join(ROOT, "vercel.json")) ? ["vercel.json"] : []),
    ];
    for (const rel of productionInputs) {
      expect(readFileSync(path.join(ROOT, rel), "utf8"), rel).not.toContain("sentry-egress-guard");
    }
  });

  it("reads no NEXT_PUBLIC_* input", () => {
    const code = readFileSync(GUARD, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("NEXT_PUBLIC");
    expect(code).toContain("process.env.HONE_E2E_SENTRY_EGRESS_LOG");
  });
});
