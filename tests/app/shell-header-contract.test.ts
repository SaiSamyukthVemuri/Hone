import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// HON-40 shell contract (DESIGN.md contract 11). The header renders every control twice (desktop and compact),
// so behaviour that must exist once per page lives in a provider mounted ONCE, in layout.tsx, above both header
// containers, and never inside the cluster that renders the two instances.
const read = (rel: string) => readFileSync(rel, "utf8");
const LAYOUT = read("app/(app)/layout.tsx");
const CLUSTER = read("app/(app)/HeaderCluster.tsx");

describe("app shell header contract", () => {
  it("each once-per-page provider is mounted exactly once, in the layout, and not in the cluster", () => {
    for (const provider of ["NotificationsProvider", "SearchProvider"]) {
      expect(LAYOUT.match(new RegExp(`<${provider}[\\s>]`, "g")) ?? [], `${provider} in layout.tsx`).toHaveLength(1);
      expect(CLUSTER, `${provider} must not be inside HeaderCluster`).not.toContain(`<${provider}`);
    }
  });

  it("both providers wrap the header, so they sit above both header containers", () => {
    const cluster = LAYOUT.indexOf("<HeaderCluster");
    expect(cluster).toBeGreaterThan(-1);
    const header = LAYOUT.lastIndexOf("<header", cluster);
    const closeHeader = LAYOUT.indexOf("</header>", cluster);
    expect(header).toBeGreaterThan(-1);
    expect(closeHeader).toBeGreaterThan(cluster);
    for (const provider of ["NotificationsProvider", "SearchProvider"]) {
      expect(LAYOUT.indexOf(`<${provider}`), `${provider} opens before the header`).toBeLessThan(header);
      expect(LAYOUT.indexOf(`</${provider}>`), `${provider} closes after the header`).toBeGreaterThan(closeHeader);
    }
  });

  it("the cluster renders each control once per header mode, and the layout renders the cluster once", () => {
    expect(LAYOUT.match(/<HeaderCluster[\s>]/g) ?? []).toHaveLength(1);
    for (const control of ["<GlobalSearch", "<NotificationsBell"]) {
      expect(CLUSTER.match(new RegExp(control, "g")) ?? [], `${control} once per mode`).toHaveLength(2);
    }
  });
});
