import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The disclosure now asks the SERVER for the full treatment. The browser says
// WHAT it wants to open; the server decides what it may have. These pin that
// split, because a behavioural test cannot see an authority that was simply
// never written.

const SRC = readFileSync(
  join(process.cwd(), "app/(app)/dashboard/prep-memory-actions.ts"),
  "utf8",
);
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the browser supplies an appointment id and NOTHING else", () => {
  it("the action takes exactly one argument", () => {
    expect(CODE).toMatch(
      /export async function loadAppointmentPrepMemory\(\s*appointmentId: string,\s*\)/,
    );
  });

  it("studio, client and the history cutoff are all SERVER-derived", () => {
    // None of these may be accepted from the caller: a forged client id or an
    // altered `before` would widen the answer.
    expect(CODE).toMatch(/const \{ studio \} = await getCurrentPractitionerWithStudio\(\)/);
    expect(CODE).toMatch(/clientId: data\.client_id/);
    expect(CODE).toMatch(/before: data\.starts_at/);
    expect(CODE).toMatch(/excludeAppointmentId: data\.id/);
    expect(CODE).toMatch(/requestKey: data\.id/);
  });
});

describe("cross-studio lookup is fenced, and says nothing about existence", () => {
  it("the appointment read is fenced on the SERVER-resolved studio", () => {
    expect(CODE).toMatch(/\.eq\("id", appointmentId\)/);
    expect(CODE).toMatch(/\.eq\("studio_id", studio\.id\)/);
  });

  it("a second, redundant tenancy check guards a silent query change", () => {
    expect(CODE).toMatch(/if \(data\.studio_id !== studio\.id\) return \{ status: "none" \}/);
  });

  it("a foreign appointment is INDISTINGUISHABLE from a missing one", () => {
    // Both return `none`. Returning a different shape would let the Dashboard
    // be used to probe whether an appointment id exists in another studio.
    const foreign = CODE.indexOf('if (data.studio_id !== studio.id) return { status: "none" }');
    const missing = CODE.indexOf('if (!data) return { status: "none" }');
    expect(foreign).toBeGreaterThan(-1);
    expect(missing).toBeGreaterThan(-1);
  });

  it("no service-role client is used", () => {
    expect(CODE).not.toMatch(/admin-server|createAdminClient|service_role/);
    expect(CODE).toMatch(/from "@\/lib\/supabase\/server"/);
  });
});

describe("failures are truthful and opaque", () => {
  it("no provider or Postgres text can reach the browser", () => {
    expect(CODE).toMatch(/catch \{/);
    expect(CODE).not.toMatch(/error\.message|\.details|\.hint/);
  });

  it("the three outcomes stay distinct", () => {
    for (const status of ['"loaded"', '"none"', '"unavailable"']) {
      expect(CODE, status).toContain(status);
    }
    // A failed read is never reported as "no treatment".
    expect(CODE).toMatch(/if \(load\.unavailable\) return \{ status: "unavailable" \}/);
    expect(CODE).toMatch(/if \(!load\.treatment\) return \{ status: "none" \}/);
  });
});

describe("the client boundary carries only the visible projection", () => {
  const COMPONENT = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/dashboard-treatment-memory.tsx"),
    "utf8",
  );
  const PAGE = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/page.tsx"),
    "utf8",
  );
  const PAGE_CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the Client Component does not accept the full model as a prop", () => {
    expect(COMPONENT).toMatch(/^"use client";/);
    expect(COMPONENT).not.toMatch(/memory: AppointmentPrepMemory \| null/);
    expect(COMPONENT).toMatch(/summary: DashboardPrepSummary/);
  });

  it("the page passes the projection, never the memory", () => {
    expect(PAGE_CODE).toMatch(/prepSummary=\{/);
    expect(PAGE_CODE).not.toMatch(/memory=\{prepMemory\.memory\}/);
  });

  it("the projection contains only fields the collapsed row paints", () => {
    const SUMMARY = readFileSync(
      join(process.cwd(), "lib/dashboard/dashboard-prep-summary.ts"),
      "utf8",
    );
    const type = SUMMARY.slice(
      SUMMARY.indexOf("export type DashboardPrepSummary"),
      SUMMARY.indexOf("};", SUMMARY.indexOf("export type DashboardPrepSummary")),
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const fields = [...type.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1]);
    expect(fields.sort()).toEqual(
      ["compactSummary", "hasTreatment", "remember", "unavailable"].sort(),
    );
  });

  it("there is NO prefetch — the fetch happens on activation only", () => {
    expect(COMPONENT).not.toMatch(/onMouseEnter|onFocus=\{.*load|IntersectionObserver|useEffect/);
    expect(COMPONENT).toMatch(/function toggle\(\)/);
    // …and once fetched it is kept, so reopening costs nothing.
    expect(COMPONENT).toMatch(/if \(!next \|\| result !== null \|\| pending\) return;/);
  });

  it("the accessible disclosure contract is preserved", () => {
    expect(COMPONENT).toMatch(/type="button"/);
    expect(COMPONENT).toMatch(/aria-expanded=\{open\}/);
    expect(COMPONENT).toMatch(/aria-controls=\{regionId\}/);
    // Outside the row's <Link>: no nested interactive elements.
    expect(PAGE_CODE).toMatch(/<\/Link>[\s\S]{0,600}<DashboardTreatmentMemory/);
  });
});

describe("four distinct failure/success paths, and they stay distinct", () => {
  const COMPONENT = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/dashboard-treatment-memory.tsx"),
    "utf8",
  );

  it("a rejected INVOCATION is contained at the call site", () => {
    // The server action returns its refusals, so a server-side failure already
    // arrives as `unavailable`. This is the other class: the browser-side
    // invocation rejecting — dropped connection, undecodable response, a
    // deployment-id mismatch on a stale tab. The action's own try/catch runs on
    // the server and cannot see any of it.
    //
    // Uncontained, React re-throws out of the transition and it reaches the
    // route error boundary, replacing the whole Dashboard because one optional
    // per-row read failed.
    expect(COMPONENT).toMatch(
      /try \{\s*setResult\(await loadAppointmentPrepMemory\(appointmentId\)\);\s*\} catch \{\s*setResult\(\{ status: "unavailable" \}\);\s*\}/,
    );
  });

  it("the thrown value is never read, rendered or logged", () => {
    // A bare `catch {` — no binding. It can carry framework and transport
    // internals, and the row already has the only copy worth showing.
    expect(COMPONENT).toMatch(/\} catch \{/);
    expect(COMPONENT).not.toMatch(/catch \(/);
    expect(COMPONENT).not.toMatch(/console\./);
  });

  it("all four paths render their own state", () => {
    // loaded → the card; none → a quiet no-detail line; unavailable →
    // the truthful failure copy, whether it came from the server or from a
    // rejected invocation. A transport failure and a server-reported failure
    // deliberately converge, because they are the same fact to the reader.
    expect(COMPONENT).toMatch(/result\.status === "loaded"/);
    expect(COMPONENT).toMatch(/result\.status === "none"/);
    expect(COMPONENT).toMatch(/Previous treatment could not be loaded/);
    expect(COMPONENT).toMatch(/<AppointmentPrepMemoryCard/);
  });

  it("containment does not disturb the cache — one fetch per mounted row", () => {
    expect(COMPONENT).toMatch(/if \(!next \|\| result !== null \|\| pending\) return;/);
  });
});
