import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildContentSecurityPolicy } from "@/lib/security/headers";

// Guards the hardened Sentry integration: no PII / Replay / Logs by default,
// scrubbers wired into every runtime, conservative production tracing, the
// strict CSP left intact (same-origin tunnel, no ingest host), and the
// temporary example page fenced off from anonymous-gate and crawlers.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const CLIENT = read("instrumentation-client.ts");
const SERVER = read("sentry.server.config.ts");
const EDGE = read("sentry.edge.config.ts");
const NEXT_CONFIG = read("next.config.ts");
const MIDDLEWARE = read("lib/supabase/middleware.ts");
const ROBOTS = read("app/robots.ts");
const GITIGNORE = read(".gitignore");

describe("Sentry init configs (client/server/edge)", () => {
  for (const [name, src] of [
    ["client", CLIENT],
    ["server", SERVER],
    ["edge", EDGE],
  ] as const) {
    it(`${name}: disables PII and wires all three scrubbers`, () => {
      expect(src).toMatch(/sendDefaultPii:\s*false/);
      expect(src).toMatch(/beforeSend:\s*scrubErrorEvent/);
      expect(src).toMatch(/beforeSendTransaction:\s*scrubTransactionEvent/);
      expect(src).toMatch(/beforeBreadcrumb:\s*scrubBreadcrumb/);
      expect(src).toMatch(/tracesSampleRate:\s*tracesSampleRate\(\)/);
    });

    it(`${name}: no Session Replay, no Logs, no inert dataCollection block`, () => {
      expect(src).not.toMatch(/replayIntegration/);
      expect(src).not.toMatch(/replaysSessionSampleRate|replaysOnErrorSampleRate/);
      expect(src).not.toMatch(/enableLogs/);
      expect(src).not.toMatch(/dataCollection/);
    });
  }
});

describe("next.config.ts Sentry build options", () => {
  it("routes events through the same-origin tunnel", () => {
    expect(NEXT_CONFIG).toMatch(/tunnelRoute:\s*"\/monitoring"/);
  });
  it("disables build telemetry and deletes source maps after upload", () => {
    expect(NEXT_CONFIG).toMatch(/telemetry:\s*false/);
    expect(NEXT_CONFIG).toMatch(/deleteSourcemapsAfterUpload:\s*true/);
  });
  it("keeps the resolved org/project", () => {
    expect(NEXT_CONFIG).toMatch(/org:\s*"hone-w1"/);
    expect(NEXT_CONFIG).toMatch(/project:\s*"javascript-nextjs"/);
  });
});

describe("CSP is left intact for the tunnel (no ingest host)", () => {
  const csp = buildContentSecurityPolicy({
    env: "production",
    supabaseUrl: "https://abc123xyz.supabase.co",
  });

  it("connect-src still allows same-origin ('self') so /monitoring works", () => {
    const connect = csp
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("connect-src "));
    expect(connect).toBeDefined();
    expect(connect).toContain("'self'");
  });

  it("does NOT add any Sentry ingest host to the policy", () => {
    expect(csp).not.toContain("ingest.sentry.io");
    expect(csp).not.toContain("sentry.io");
  });
});

describe("middleware allowlists the production tunnel", () => {
  it("keeps /monitoring reachable for anonymous requests (client error reporting)", () => {
    expect(MIDDLEWARE).toMatch(/pathname === "\/monitoring"/);
  });
  it("no longer references the removed example routes", () => {
    // The temporary Sentry example page + API route are removed before merge;
    // their allowlist/robots fences must go with them.
    expect(MIDDLEWARE).not.toMatch(/sentry-example/);
    expect(ROBOTS).not.toMatch(/sentry-example/);
  });
});

describe("secrets stay out of git", () => {
  it(".env.sentry-build-plugin is gitignored", () => {
    expect(GITIGNORE).toMatch(/^\.env\.sentry-build-plugin$/m);
  });
});
