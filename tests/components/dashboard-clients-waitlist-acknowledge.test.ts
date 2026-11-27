import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// HON-109 slice 2: the six Dashboard, Clients and Waitlist controls that gave NO acknowledgement before the result (measured 0.4-0.7 s, 17-20 of 20
// runs over the 100 ms budget). Source contract: each now goes through the pending vocabulary, and the existing rules around them still hold.
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

describe("HON-109 slice 2: controls that were silent now acknowledge", () => {
  it("Dashboard: Review session / row actions, and Practice capacity (container form, it is a two-column row)", () => {
    expect(read("app/(app)/dashboard/needs-attention-panel.tsx").match(/<PendingLink\b/g)).toHaveLength(3);
    expect(read("app/(app)/dashboard/todo-list.tsx")).toMatch(/<PendingLink[\s\S]{0,80}href=\{item\.action\.href\}/);
    expect(read("app/(app)/dashboard/secondary-stack.tsx")).toMatch(/<PendingContainerLink[\s\S]{0,80}href="\/dashboard\/capacity"/);
  });

  it("Clients: Add client and Details go through PendingLink; Details stays in place (query-only, no scroll)", () => {
    expect(read("app/(app)/clients/page.tsx")).toMatch(/<PendingLink[\s\S]{0,80}href="\/clients\/new"/);
    const d = read("app/(app)/clients/ClientsDirectory.tsx");
    expect(d).toMatch(/<PendingLink[\s\S]{0,200}scroll=\{false\}[\s\S]{0,200}aria-expanded=\{selected\}/);
  });

  it("Clients form shows a VISIBLE mark, not aria-busy alone, with an always-mounted live region", () => {
    const c = read("app/(app)/clients/DirectoryControls.tsx");
    expect(c).toMatch(/pending \? <span data-pending-mark="true"/);
    expect(c).toMatch(/<span role="status" className="sr-only">\{pending \? "Updating clients…" : ""\}<\/span>/);
    expect(c).toContain("aria-busy={pending}");
  });

  it("Waitlist: search is a native-mode PendingGetForm (browser GET, Back/Forward restore unchanged); invite link acknowledges the press", () => {
    const q = read("components/waitlist/workspace-queue.tsx");
    expect(q).toMatch(/<PendingGetForm native action=\{WAITLIST_SEARCH_PATH\}[\s\S]*<PendingSubmit disabled=\{pending\}[\s\S]*<\/PendingGetForm>/);
    expect(q).not.toMatch(/<form\b/);
    const n = read("components/waitlist/waitlist-nav-link.tsx");
    expect(n).toContain('data-link-pending="true"');
    expect(n).toMatch(/<a \{\.\.\.anchorRest\} onClick=\{handleClick\} href=\{href\}/); // still a plain anchor: no soft navigation over an in-flight send
    expect(n).toMatch(/e\.persisted\) setGoing\(false\)/); // cleared on a bfcache restore
  });
});
