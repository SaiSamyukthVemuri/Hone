import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  buildGlobalSecurityHeaders,
  buildTokenRoutePrivacyHeaders,
} from "@/lib/security/headers";

const PROD_ARGS = {
  env: "production" as const,
  supabaseUrl: "https://abc123xyz.supabase.co",
};
const DEV_ARGS = {
  env: "development" as const,
  supabaseUrl: "https://abc123xyz.supabase.co",
};

function findHeader(headers: { key: string; value: string }[], key: string) {
  return headers.find((h) => h.key.toLowerCase() === key.toLowerCase());
}

function cspDirective(csp: string, name: string): string {
  // Directives are separated by `; ` in the rendered value. Lookup
  // by leading directive name.
  const part = csp.split(";").map((s) => s.trim()).find((s) =>
    s === name || s.startsWith(`${name} `),
  );
  return part ?? "";
}

describe("buildGlobalSecurityHeaders", () => {
  const headers = buildGlobalSecurityHeaders(PROD_ARGS);

  it("includes Strict-Transport-Security with one year + preload", () => {
    const h = findHeader(headers, "Strict-Transport-Security");
    expect(h?.value).toBe(
      "max-age=31536000; includeSubDomains; preload",
    );
  });

  it("forces X-Frame-Options to DENY (clickjacking protection)", () => {
    const h = findHeader(headers, "X-Frame-Options");
    expect(h?.value).toBe("DENY");
  });

  it("includes X-Content-Type-Options: nosniff", () => {
    const h = findHeader(headers, "X-Content-Type-Options");
    expect(h?.value).toBe("nosniff");
  });

  it("global Referrer-Policy is strict-origin-when-cross-origin", () => {
    const h = findHeader(headers, "Referrer-Policy");
    expect(h?.value).toBe("strict-origin-when-cross-origin");
  });

  it("Permissions-Policy locks down camera, microphone, geolocation, payment, ...", () => {
    const h = findHeader(headers, "Permissions-Policy");
    expect(h?.value).toContain("camera=()");
    expect(h?.value).toContain("microphone=()");
    expect(h?.value).toContain("geolocation=()");
    expect(h?.value).toContain("payment=()");
    expect(h?.value).toContain("usb=()");
    expect(h?.value).toContain("interest-cohort=()");
  });

  it("includes a Content-Security-Policy header", () => {
    const h = findHeader(headers, "Content-Security-Policy");
    expect(h).toBeDefined();
    expect((h?.value ?? "").length).toBeGreaterThan(0);
  });
});

describe("buildContentSecurityPolicy", () => {
  it("includes frame-ancestors 'none' (clickjacking protection)", () => {
    const csp = buildContentSecurityPolicy(PROD_ARGS);
    expect(cspDirective(csp, "frame-ancestors")).toBe(
      "frame-ancestors 'none'",
    );
  });

  it("includes Stripe Elements script, frame, and connect sources", () => {
    const csp = buildContentSecurityPolicy(PROD_ARGS);
    expect(cspDirective(csp, "script-src")).toContain(
      "https://js.stripe.com",
    );
    expect(cspDirective(csp, "frame-src")).toContain(
      "https://js.stripe.com",
    );
    expect(cspDirective(csp, "frame-src")).toContain(
      "https://hooks.stripe.com",
    );
    expect(cspDirective(csp, "connect-src")).toContain(
      "https://api.stripe.com",
    );
    expect(cspDirective(csp, "connect-src")).toContain(
      "https://r.stripe.com",
    );
    expect(cspDirective(csp, "connect-src")).toContain(
      "https://q.stripe.com",
    );
  });

  it("includes Vercel Analytics + Speed Insights for safe-route mounts", () => {
    const csp = buildContentSecurityPolicy(PROD_ARGS);
    expect(cspDirective(csp, "script-src")).toContain(
      "https://va.vercel-scripts.com",
    );
    expect(cspDirective(csp, "connect-src")).toContain(
      "https://va.vercel-scripts.com",
    );
    expect(cspDirective(csp, "connect-src")).toContain(
      "https://vitals.vercel-insights.com",
    );
  });

  it("scopes Supabase connect-src to the specific project host", () => {
    const csp = buildContentSecurityPolicy(PROD_ARGS);
    expect(cspDirective(csp, "connect-src")).toContain(
      "https://abc123xyz.supabase.co",
    );
    // The wildcard form must NOT appear when a concrete URL was supplied.
    expect(cspDirective(csp, "connect-src")).not.toContain(
      "https://*.supabase.co",
    );
  });

  it("falls back to *.supabase.co only when supabaseUrl is missing", () => {
    const csp = buildContentSecurityPolicy({
      env: "production",
      supabaseUrl: null,
    });
    expect(cspDirective(csp, "connect-src")).toContain(
      "https://*.supabase.co",
    );
  });

  it("does NOT include any Sentry domain (Sentry is not installed)", () => {
    const csp = buildContentSecurityPolicy(PROD_ARGS);
    expect(csp).not.toContain("sentry.io");
    expect(csp).not.toContain("ingest.sentry.io");
  });

  it("does NOT include a wildcard `*` source", () => {
    const csp = buildContentSecurityPolicy(PROD_ARGS);
    // Allow specific tokens like `data:` and the *.supabase.co fallback
    // but reject a standalone `*`.
    const tokens = csp.split(/[\s;]+/).filter(Boolean);
    expect(tokens).not.toContain("*");
    // Also reject `default-src *` and similar wildcards.
    expect(csp).not.toMatch(/[a-z-]+-src\s+\*/);
  });

  it("does NOT include fonts.gstatic.com or fonts.googleapis.com (next/font self-hosts)", () => {
    const csp = buildContentSecurityPolicy(PROD_ARGS);
    expect(csp).not.toContain("fonts.gstatic.com");
    expect(csp).not.toContain("fonts.googleapis.com");
  });

  it("script-src never includes data:", () => {
    const csp = buildContentSecurityPolicy(PROD_ARGS);
    expect(cspDirective(csp, "script-src")).not.toContain("data:");
  });

  it("includes upgrade-insecure-requests as a valueless directive", () => {
    const csp = buildContentSecurityPolicy(PROD_ARGS);
    // The directive renders with no value (no trailing tokens).
    expect(csp).toMatch(/(^|;\s)upgrade-insecure-requests($|;)/);
  });

  it("includes 'unsafe-eval' ONLY in development (Next HMR)", () => {
    const prod = buildContentSecurityPolicy(PROD_ARGS);
    const dev = buildContentSecurityPolicy(DEV_ARGS);
    expect(cspDirective(prod, "script-src")).not.toContain("'unsafe-eval'");
    expect(cspDirective(dev, "script-src")).toContain("'unsafe-eval'");
  });

  it("keeps 'unsafe-inline' in production for the first baseline (Next inline hydration)", () => {
    const prod = buildContentSecurityPolicy(PROD_ARGS);
    expect(cspDirective(prod, "script-src")).toContain("'unsafe-inline'");
  });
});

describe("buildTokenRoutePrivacyHeaders", () => {
  const headers = buildTokenRoutePrivacyHeaders();

  it("returns X-Robots-Tag: noindex, nofollow", () => {
    const h = findHeader(headers, "X-Robots-Tag");
    expect(h?.value).toBe("noindex, nofollow");
  });

  it("returns Referrer-Policy: no-referrer (overrides the global default)", () => {
    const h = findHeader(headers, "Referrer-Policy");
    expect(h?.value).toBe("no-referrer");
  });
});
