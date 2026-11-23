import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The bell's visible number and the layout's wiring of it. NotificationsBell renders through react-dom/server so the rule is asserted
// on what a person sees, not on a source spelling.

import { NotificationsBell } from "@/app/(app)/NotificationsBell";
import { NotificationsProvider } from "@/app/(app)/NotificationsProvider";

const bell = (unread: number) => renderToStaticMarkup(createElement(NotificationsBell, { unread }));
const badge = (html: string) => html.match(/<span aria-hidden="true"[^>]*>([^<]*)<\/span>/)?.[1] ?? null;
const label = (html: string) => html.match(/aria-label="([^"]*)"/)?.[1];

describe("the bell's number", () => {
  it.each([
    [0, null, "Notifications"],
    [1, "1", "Notifications, 1 unread"],
    [99, "99", "Notifications, 99 unread"],
    [100, "99+", "Notifications, 100 unread"],
    [250, "99+", "Notifications, 250 unread"],
  ])("%i unread shows %s", (n, shown, name) => {
    expect(badge(bell(n))).toBe(shown);
    expect(label(bell(n))).toBe(name);
  });

  it("keeps its test id and destination", () => {
    const html = bell(3);
    expect(html).toContain('data-testid="nav-notifications"');
    expect(html).toContain('href="/notifications"');
  });
});

describe("the live count the provider hands both bell instances", () => {
  const withProvider = (persisted: number, computed: number) =>
    renderToStaticMarkup(
      createElement(NotificationsProvider, {
        initialPersistedUnread: persisted,
        computedUnread: computed,
        children: [createElement(NotificationsBell, { key: "a", unread: 0 }), createElement(NotificationsBell, { key: "b", unread: 0 })],
      }),
    );

  it("both instances show persisted + computed, not the fallback prop", () => {
    const html = withProvider(2, 3);
    const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["Notifications, 5 unread", "Notifications, 5 unread"]);
  });

  it("a computed-only alert still lights the bell", () => {
    expect(label(withProvider(0, 4))).toBe("Notifications, 4 unread");
  });

  it("the 99+ cap applies to the SUM", () => {
    expect(badge(withProvider(60, 60))).toBe("99+");
  });
});

describe("the layout feeds the shell the server counts", () => {
  const layout = readFileSync("app/(app)/layout.tsx", "utf8");
  it("mounts the provider ONCE with the persisted and the computed count", () => {
    expect(layout.match(/<NotificationsProvider\b/g)).toHaveLength(1);
    expect(layout).toMatch(/<NotificationsProvider\s+initialPersistedUnread=\{unreadPersisted\}\s+computedUnread=\{overdueDisinfectantCount\}>/);
  });
  it("hands the header the computed overdue-disinfectant count, never a constant", () => {
    expect(layout).toMatch(/<HeaderCluster[\s\S]*?unreadPersisted=\{unreadPersisted\}[\s\S]*?computedUnread=\{overdueDisinfectantCount\}/);
  });
});
