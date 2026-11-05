import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Sam's decision, 2 Nov: a practitioner who opens ANY owner-only settings route
// gets one clear access-denied state in place -- never a redirect, never a
// partial render, never data. This pins the full route list, renders every one
// as a practitioner, and proves the refusal happens before any database client
// is even constructed (so nothing studio-wide can reach the RSC payload).

const queries = vi.hoisted(() => ({
  requirePractitionerWithStudio: vi.fn(),
}));
const clients = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));
const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/queries", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requirePractitionerWithStudio: queries.requirePractitionerWithStudio,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: clients.createClient }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: clients.createAdminClient }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  redirect: nav.redirect,
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

import { OWNER_ONLY_BACK_HREF, OWNER_ONLY_HEADING } from "@/components/settings/view-heading";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PageModule = { default: (p: any) => unknown };
// Literal imports: a computed path cannot be bundled, and a glob misses the parenthesised group.
const loaders: Record<string, () => Promise<PageModule>> = {
  "launch/page.tsx": () => import("@/app/(app)/settings/launch/page"),
  "studio/page.tsx": () => import("@/app/(app)/settings/studio/page"),
  "studio/details/page.tsx": () => import("@/app/(app)/settings/studio/details/page"),
  "studio/email/page.tsx": () => import("@/app/(app)/settings/studio/email/page"),
  "studio/text-messages/page.tsx": () => import("@/app/(app)/settings/studio/text-messages/page"),
  "studio/client-self-service/page.tsx": () => import("@/app/(app)/settings/studio/client-self-service/page"),
  "forms/postcare/page.tsx": () => import("@/app/(app)/settings/forms/postcare/page"),
  "forms/cancellation-policy/page.tsx": () => import("@/app/(app)/settings/forms/cancellation-policy/page"),
  "team/page.tsx": () => import("@/app/(app)/settings/team/page"),
  "roles/page.tsx": () => import("@/app/(app)/settings/roles/page"),
  "booking/page.tsx": () => import("@/app/(app)/settings/booking/page"),
  "booking/link/page.tsx": () => import("@/app/(app)/settings/booking/link/page"),
  "booking/window/page.tsx": () => import("@/app/(app)/settings/booking/window/page"),
  "waitlist/page.tsx": () => import("@/app/(app)/settings/waitlist/page"),
  "availability/page.tsx": () => import("@/app/(app)/settings/availability/page"),
  "services/page.tsx": () => import("@/app/(app)/settings/services/page"),
  "machines/page.tsx": () => import("@/app/(app)/settings/machines/page"),
  "consent/page.tsx": () => import("@/app/(app)/settings/consent/page"),
  "payments/page.tsx": () => import("@/app/(app)/settings/payments/page"),
  "payments/setup/page.tsx": () => import("@/app/(app)/settings/payments/setup/page"),
  "payments/card-on-file/page.tsx": () => import("@/app/(app)/settings/payments/card-on-file/page"),
  "payments/fees/page.tsx": () => import("@/app/(app)/settings/payments/fees/page"),
  "payments/refresh/page.tsx": () => import("@/app/(app)/settings/payments/refresh/page"),
  "payments/return/page.tsx": () => import("@/app/(app)/settings/payments/return/page"),
  "integrations/page.tsx": () => import("@/app/(app)/settings/integrations/page"),
  "integrations/google-calendar/page.tsx": () => import("@/app/(app)/settings/integrations/google-calendar/page"),
  "integrations/text-messaging/page.tsx": () => import("@/app/(app)/settings/integrations/text-messaging/page"),
  "integrations/marketing/page.tsx": () => import("@/app/(app)/settings/integrations/marketing/page"),
  "tracking/page.tsx": () => import("@/app/(app)/settings/tracking/page"),
  "import/page.tsx": () => import("@/app/(app)/settings/import/page"),
  "data/page.tsx": () => import("@/app/(app)/settings/data/page"),
  "calendar/display/page.tsx": () => import("@/app/(app)/settings/calendar/display/page"),
};
const ROOT = path.join(process.cwd(), "app/(app)/settings");

// EVERY route that refuses a practitioner. A doorway (a thin index that used to
// redirect) is listed too: it refuses in place rather than sending the visitor
// somewhere else first.
const OWNER_ONLY_ROUTES: Record<string, string> = {
  "/settings/launch": "launch/page.tsx",
  "/settings/studio": "studio/page.tsx",
  "/settings/studio/details": "studio/details/page.tsx",
  "/settings/studio/email": "studio/email/page.tsx",
  "/settings/studio/text-messages": "studio/text-messages/page.tsx",
  "/settings/studio/client-self-service": "studio/client-self-service/page.tsx",
  "/settings/forms/postcare": "forms/postcare/page.tsx",
  "/settings/forms/cancellation-policy": "forms/cancellation-policy/page.tsx",
  "/settings/team": "team/page.tsx",
  "/settings/roles": "roles/page.tsx",
  "/settings/booking": "booking/page.tsx",
  "/settings/booking/link": "booking/link/page.tsx",
  "/settings/booking/window": "booking/window/page.tsx",
  "/settings/waitlist": "waitlist/page.tsx",
  "/settings/availability": "availability/page.tsx",
  "/settings/services": "services/page.tsx",
  "/settings/machines": "machines/page.tsx",
  "/settings/consent": "consent/page.tsx",
  "/settings/payments": "payments/page.tsx",
  "/settings/payments/setup": "payments/setup/page.tsx",
  "/settings/payments/card-on-file": "payments/card-on-file/page.tsx",
  "/settings/payments/fees": "payments/fees/page.tsx",
  "/settings/payments/refresh": "payments/refresh/page.tsx",
  "/settings/payments/return": "payments/return/page.tsx",
  "/settings/integrations": "integrations/page.tsx",
  "/settings/integrations/google-calendar": "integrations/google-calendar/page.tsx",
  "/settings/integrations/text-messaging": "integrations/text-messaging/page.tsx",
  "/settings/integrations/marketing": "integrations/marketing/page.tsx",
  "/settings/tracking": "tracking/page.tsx",
  "/settings/import": "import/page.tsx",
  "/settings/data": "data/page.tsx",
  "/settings/calendar/display": "calendar/display/page.tsx",
};

// Routes open to a practitioner: a doorway to a view they may see, or a view
// they may use. Listing them makes a NEW page fail this test until someone says
// which side of the line it is on.
const PRACTITIONER_ROUTES = [
  "settings/page.tsx",
  "profile/page.tsx",
  "calendar/page.tsx",
  "calendar/[view]/page.tsx",
  "forms/page.tsx",
  "forms/intake-preview/page.tsx",
  "intake/page.tsx",
].map((p) => p.replace(/^settings\//, ""));

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name === "page.tsx" ? [path.relative(ROOT, full)] : [];
  });
}

describe("owner-only settings routes refuse a practitioner in place", () => {
  it("every settings page is classified as owner-only or practitioner-open", () => {
    const all = pages(ROOT).sort();
    const classified = [...Object.values(OWNER_ONLY_ROUTES), ...PRACTITIONER_ROUTES].sort();
    expect(all).toEqual(classified);
  });

  it("the owner-only list is the rail's owner-only entries plus their doorways and return routes", () => {
    const registry = readFileSync(path.join(process.cwd(), "lib/settings/nav-registry.ts"), "utf8");
    const calendar = readFileSync(path.join(ROOT, "calendar/nav.ts"), "utf8");
    const launch = readFileSync(path.join(ROOT, "launch/nav.ts"), "utf8");
    // Every href declared in the registry that is OWNER-only (an entry with
    // `roles: OWNER`, or a child with `roles: OWNER`) must be in the list.
    const ownerHrefs = new Set<string>();
    for (const m of registry.matchAll(/href: "(\/settings\/[^"]+)",\s*roles: OWNER/g)) ownerHrefs.add(m[1]);
    for (const m of registry.matchAll(/id: "[^"]+", label: "[^"]+", href: "(\/settings\/[^"]+)", roles: OWNER/g)) ownerHrefs.add(m[1]);
    // Children of an OWNER entry are owner-only by inheritance.
    for (const block of registry.split(/\n  \{\n/).filter((b) => /roles: OWNER,/.test(b.split("children")[0] ?? ""))) {
      for (const m of block.matchAll(/children: \[([\s\S]*?)\n    \]/g)) {
        for (const h of m[1].matchAll(/href: "(\/settings\/[^"]+)"/g)) ownerHrefs.add(h[1]);
      }
    }
    for (const m of calendar.matchAll(/href: "(\/settings\/[^"]+)",\s*roles: \["owner"\]/g)) ownerHrefs.add(m[1]);
    for (const m of launch.matchAll(/href: "(\/settings\/[^"]+)",\s*roles: \["owner"\]/g)) ownerHrefs.add(m[1]);
    expect(ownerHrefs.size).toBeGreaterThan(15);
    for (const href of ownerHrefs) expect(Object.keys(OWNER_ONLY_ROUTES), href).toContain(href);
  });

  it("no refusal path in an owner-only page redirects a practitioner", () => {
    for (const [route, file] of Object.entries(OWNER_ONLY_ROUTES)) {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      // The only redirects allowed are the owner's own ones (launch complete,
      // Stripe hand-off), never one keyed on the practitioner role.
      expect(src, route).not.toMatch(/role !== "owner"\)\s*redirect\(/);
      expect(src, route).not.toMatch(/role !== "owner"\) \{\s*redirect\(/);
    }
  });

  describe("rendered as a practitioner", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      queries.requirePractitionerWithStudio.mockResolvedValue({
        practitioner: { id: "p-1", role: "practitioner", active: true },
        studio: { id: "s-1", name: "Synthetic Studio", slug: "synthetic" },
        user: { id: "u-1" },
      });
    });

    // Resolve a server component the way React would: call async function
    // components until plain markup is left.
    async function resolve(node: unknown, depth = 0): Promise<unknown> {
      if (depth > 6) return node;
      if (isValidElement(node) && typeof node.type === "function") {
        const out = await (node.type as (p: unknown) => unknown)(node.props);
        return resolve(out, depth + 1);
      }
      return node;
    }

    it.each(Object.entries(OWNER_ONLY_ROUTES))("%s shows the shared access-denied state", async (route, file) => {
      const mod = await loaders[file]();
      const out = await resolve(
        await mod.default({ searchParams: Promise.resolve({}), params: Promise.resolve({}) }),
      );
      expect(nav.redirect, route).not.toHaveBeenCalled();
      const html = renderToStaticMarkup(out as ReactElement);
      expect(html, route).toContain('data-testid="owner-only-denied"');
      expect(html, route).toContain(OWNER_ONLY_HEADING);
      expect(html, route).toContain(`href="${OWNER_ONLY_BACK_HREF}"`);
      // Nothing studio-specific, and no second view heading.
      expect(html, route).not.toContain("Synthetic Studio");
      expect((html.match(/data-settings-heading/g) ?? []).length, route).toBe(1);
      // Refused before any database client existed: nothing could be read.
      expect(clients.createClient, route).not.toHaveBeenCalled();
      expect(clients.createAdminClient, route).not.toHaveBeenCalled();
    });
  });

  it("the shared component is the one every refusal uses", () => {
    for (const [route, file] of Object.entries(OWNER_ONLY_ROUTES)) {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      const viaView = /<(BookingView|PaymentsView)\b/.test(src);
      if (viaView) continue;
      expect(src, route).toContain("OwnerOnlyNotice");
    }
    expect(readFileSync(path.join(ROOT, "booking/BookingView.tsx"), "utf8")).toContain("OwnerOnlyNotice");
    expect(readFileSync(path.join(ROOT, "payments/PaymentsView.tsx"), "utf8")).toContain("OwnerOnlyNotice");
  });
});
