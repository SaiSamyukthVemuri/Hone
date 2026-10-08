import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { middleware } from "../../../middleware";
import { updateSession } from "@/lib/supabase/middleware";
import { isUnknownPublicPath } from "@/lib/marketing/agent-http";

// Exercise BOTH real middleware layers together, not merely the classifier or
// the auth helper alone. Only the Supabase identity read is synthetic: no
// hosted database, credentials, or customer data are needed for routing proof.
const { getUser } = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/admin", () => ({
  isAdmin: () => false,
}));

beforeEach(() => { getUser.mockClear(); });

async function navigate(path: string) {
  const request = new NextRequest("https://hone.care" + path);
  const response = await updateSession(request);
  return { response, request };
}

describe("public route trailing slashes at the real Supabase auth gate", () => {
  it("passes shipped feature paths to Next without an anonymous /login redirect", async () => {
    for (const route of [
      "/features/treatment-memory",
      "/features/treatment-memory/",
      "/features/booking-calendar/",
      "/features/charting-records/",
      "/pricing/",
      "/privacy/",
      "/resources/",
    ]) {
      const { response, request } = await navigate(route);
      expect(response.status, route).toBe(200);
      expect(response.headers.get("location"), route).toBeNull();
      expect(request.nextUrl.pathname, route).toBe(route);
    }
  });

  it("does not accidentally authorize unshipped feature or protected routes", async () => {
    for (const route of [
      "/features/not-real/",
      "/features/waitlist-invitation/",
      "/dashboard/",
      "/settings/",
      "/clients/",
      "/admin/",
    ]) {
      const { response, request } = await navigate(route);
      expect(response.status, route).toBe(307);
      const target = response.headers.get("location");
      expect(target, route).toBeTruthy();
      expect(new URL(target!).pathname, route).toBe("/login");
      expect(request.nextUrl.pathname, route).toBe(route);
    }
  });

  it("continues to allow token-bearing routes to perform their own checks", async () => {
    for (const route of [
      "/invitation/synthetic-token",
      "/portal/verify/synthetic-token",
      "/manage/synthetic-token",
    ]) {
      const { response } = await navigate(route);
      expect(response.status, route).toBe(200);
      expect(response.headers.get("location"), route).toBeNull();
    }
  });
});

describe("composed middleware: raw path, one comparison normalization, then auth", () => {
  const missingPaths = [
    "/about//", "/about///", "/contact//", "/privacy//", "/pricing//",
    "/features/treatment-memory//", "/features/booking-calendar//",
    "/features/charting-records//", "/features", "/features/",
    "/features/not-real", "/features/not-real/",
    "/features/waitlist-invitation", "/features/waitlist-invitation/",
    "/features/waitlist-invitation//", "/not-real", "/not-real/",
  ];
  for (const accept of ["text/html", "text/markdown"] as const) {
    for (const method of ["GET", "HEAD"] as const) {
      it.each(missingPaths)(`${method} %s (${accept}) is a terminal 404, never a login redirect`, async (route) => {
        const request = new NextRequest("https://hone.care" + route + "?probe=synthetic", {
          method, headers: { Accept: accept },
        });
        const response = await middleware(request);
        expect(response.status).toBe(404);
        expect(response.headers.get("location")).toBeNull();
        expect(response.headers.get("Content-Type")).toMatch(new RegExp("^" + accept));
        expect(response.headers.get("Vary")?.toLowerCase()).toContain("accept");
        // The 404 decision happens before any real identity lookup.
        expect(getUser).not.toHaveBeenCalled();
        expect(request.nextUrl.pathname).toBe(route);
        expect(request.nextUrl.search).toBe("?probe=synthetic");
        const body = await response.text();
        if (method === "HEAD") {
          expect(body).toBe("");
        } else {
          expect(body.length).toBeGreaterThan(20);
          expect(body).toContain("/llms.txt");
          expect(body).toContain("/sitemap.xml");
        }
      });
    }
  }

  it.each([
    "/about/", "/contact/", "/pricing/", "/privacy/",
    "/features/treatment-memory/", "/features/booking-calendar/",
    "/features/charting-records/",
  ])("keeps the supported single-slash page %s reachable through both middleware layers", async (route) => {
    const request = new NextRequest("https://hone.care" + route, {
      headers: { Accept: "text/html" },
    });
    const response = await middleware(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(request.nextUrl.pathname).toBe(route);
  });

  it.each(["/dashboard/", "/clients/", "/admin/", "/settings/"])(
    "keeps private path %s behind the actual auth gate", async (route) => {
      const response = await middleware(new NextRequest("https://hone.care" + route, {
        headers: { Accept: "text/markdown" },
      }));
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
      expect(getUser).toHaveBeenCalledOnce();
    },
  );

  it("keeps the real invitation token route separate from the component-only feature folder", async () => {
    const request = new NextRequest("https://hone.care/invitation/synthetic-token");
    const response = await middleware(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(getUser).toHaveBeenCalledOnce();
    expect(request.nextUrl.pathname).toBe("/invitation/synthetic-token");
  });

  it("recognizes feature entrypoints on disk, not component directory names", () => {
    const root = path.join(process.cwd(), "app/features");
    const directories = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    expect(directories.length).toBeGreaterThan(0);
    for (const entry of directories) {
      // This finite namespace has static pages. Adding dynamic routing here
      // needs an explicit classifier/test change, not a prefix exemption.
      const hasEntrypoint = ["page.tsx", "page.ts", "page.jsx", "page.js", "route.ts", "route.js"]
        .some((file) => existsSync(path.join(root, entry.name, file)));
      expect(isUnknownPublicPath("/features/" + entry.name), entry.name).toBe(!hasEntrypoint);
    }
    expect(existsSync(path.join(root, "waitlist-invitation/InvitationScreen.tsx"))).toBe(true);
    expect(isUnknownPublicPath("/features/waitlist-invitation")).toBe(true);
  });
});
