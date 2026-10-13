import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// PAY-CCY-09 (Codex P2 4264919601). The payment web server's Stripe egress
// guard, run as a real preload: every network stack that could
// reach *.stripe.com is refused and recorded, loopback still works, and a
// deployed-runtime signal refuses to start.

const ROOT = path.resolve(__dirname, "../..");
const GUARD = path.join(ROOT, "e2e-payment/helpers/stripe-egress-guard.cjs");

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST"]) {
    delete env[k];
  }
  return env;
}

function runWithGuard(script: string, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "stripe-egress-"));
  const log = path.join(dir, "egress.jsonl");
  try {
    const res = spawnSync(process.execPath, ["--require", GUARD, "-e", script], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...baseEnv(), HONE_E2E_STRIPE_EGRESS_LOG: log, ...extraEnv },
    });
    const entries = existsSync(log)
      ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { ...res, entries };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("stripe egress guard (server preload)", () => {
  it("refuses https.request to api.stripe.com, sends nothing, and records it", () => {
    const r = runWithGuard(`
      const https = require("node:https");
      const req = https.request("https://api.stripe.com/v1/charges", { method: "POST" });
      req.on("error", (e) => { console.log("ERR " + e.code); });
      req.end("amount=100");
    `);
    expect(r.stdout).toContain("ERR ECONNREFUSED");
    expect(r.entries.filter((e: { kind: string }) => e.kind === "refused")).toEqual([
      expect.objectContaining({ kind: "refused", via: "https.request", host: "api.stripe.com" }),
    ]);
    expect(r.entries.some((e: { kind: string }) => e.kind === "armed")).toBe(true);
  });

  it("refuses fetch and raw TLS/TCP to any *.stripe.com host", () => {
    const r = runWithGuard(`
      const tls = require("node:tls");
      const net = require("node:net");
      fetch("https://files.stripe.com/x").then(() => console.log("FETCH OK"), (e) => console.log("FETCH " + e.cause.code));
      tls.connect(443, "api.stripe.com").on("error", (e) => console.log("TLS " + e.code));
      net.connect(443, "connect.stripe.com").on("error", (e) => console.log("NET " + e.code));
    `);
    expect(r.stdout).toContain("FETCH ECONNREFUSED");
    expect(r.stdout).toContain("TLS ECONNREFUSED");
    expect(r.stdout).toContain("NET ECONNREFUSED");
    expect(r.entries.filter((e: { kind: string }) => e.kind === "refused").map((e: { via: string }) => e.via).sort()).toEqual(["fetch", "net.connect", "tls.connect"]);
  });

  it("the REAL Stripe SDK client (what the server would use) is refused and recorded", () => {
    const r = runWithGuard(`
      const Stripe = require(${JSON.stringify(path.join(ROOT, "node_modules/stripe"))});
      const s = new Stripe("sk_test_egress_guard_probe", { maxNetworkRetries: 0 });
      s.paymentIntents.retrieve("pi_probe").then(
        () => console.log("SDK REACHED STRIPE"),
        (e) => console.log("SDK " + e.type),
      );
    `);
    expect(r.stdout).toContain("SDK StripeConnectionError");
    expect(r.stdout).not.toContain("REACHED");
    // The refusal and its record are non-secret: the key never appears.
    expect(r.stdout + r.stderr + JSON.stringify(r.entries)).not.toContain("sk_test_egress_guard_probe");
    expect(r.entries.filter((e: { kind: string }) => e.kind === "refused").map((e: { host: string }) => e.host)).toContain("api.stripe.com");
  });

  it("CONTROL: loopback HTTP is untouched and nothing is recorded", () => {
    const r = runWithGuard(`
      const http = require("node:http");
      const s = http.createServer((q, a) => a.end("ok")).listen(0, "127.0.0.1", () => {
        http.get("http://127.0.0.1:" + s.address().port + "/", (res) => {
          res.on("data", (d) => { console.log("BODY " + d); s.close(); });
        });
      });
    `);
    expect(r.stdout).toContain("BODY ok");
    expect(r.entries.filter((e: { kind: string }) => e.kind === "refused")).toEqual([]);
  });

  it("does not match look-alike hosts", () => {
    const r = runWithGuard(`
      const net = require("node:net");
      // Refused by the OS (nothing listens), but NOT by the guard: no record.
      net.connect(9, "127.0.0.1").on("error", () => console.log("done"));
    `);
    expect(r.entries.filter((e: { kind: string }) => e.kind === "refused")).toEqual([]);
    expect(r.stdout).toContain("done");
  });

  it("refuses to start under a deployed-runtime signal", () => {
    const r = runWithGuard(`console.log("RAN")`, { VERCEL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("RAN");
    expect(r.stderr).toContain("REFUSING TO START");
  });
});

describe("the payment web server loads it", () => {
  it("keeps the core lanes' Sentry --require exactly, and adds the Stripe guard by --import", async () => {
    const env = await import("@/e2e-payment/helpers/payment-env");
    const core = await import("@/e2e/helpers/local-env");
    const opts = env.PAYMENT_WEB_SERVER_ENV.NODE_OPTIONS;
    expect(opts.startsWith(core.E2E_WEB_SERVER_ENV.NODE_OPTIONS)).toBe(true);
    // Next merges a REPEATED flag into one bogus path, so --require stays single.
    expect(opts.match(/--require\b/g) ?? []).toHaveLength(1);
    expect(opts).toContain("--import file://");
    expect(opts).toContain("stripe-egress-guard.cjs");
    expect(env.PAYMENT_WEB_SERVER_ENV.HONE_E2E_STRIPE_EGRESS_LOG).toBe(env.PAYMENT_STRIPE_EGRESS_LOG);
  });

  it("survives Next's own NODE_OPTIONS re-format and arms BOTH guards in the child", async () => {
    const env = await import("@/e2e-payment/helpers/payment-env");
    // 1. What Next hands its build/start children (its real parser/formatter).
    const fmt = spawnSync(
      process.execPath,
      [
        "-e",
        `const u = require(${JSON.stringify(path.join(ROOT, "node_modules/next/dist/server/lib/utils.js"))});
         process.stdout.write(u.getFormattedNodeOptionsWithoutInspect());`,
      ],
      { encoding: "utf8", timeout: 20_000, env: { ...baseEnv(), NODE_OPTIONS: env.PAYMENT_WEB_SERVER_ENV.NODE_OPTIONS } },
    );
    expect(fmt.status).toBe(0);
    // 2. A child started with exactly that NODE_OPTIONS has both guards armed.
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `console.log(JSON.stringify({
           sentry: !!globalThis[Symbol.for("hone.e2e.sentryEgressGuard")]?.active,
           stripe: !!globalThis[Symbol.for("hone.e2e.stripeEgressGuard")]?.active,
         }))`,
      ],
      { encoding: "utf8", timeout: 20_000, env: { ...baseEnv(), NODE_OPTIONS: fmt.stdout } },
    );
    expect(child.stderr).not.toMatch(/Cannot find module/);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim().split("\n").pop()!)).toEqual({ sentry: true, stripe: true });
  });
});
