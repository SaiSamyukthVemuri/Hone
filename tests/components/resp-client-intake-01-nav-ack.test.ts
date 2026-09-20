import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// RESP-CLIENT-INTAKE-01 — the clinical navigation slice, pinned at the source.
//
// The behavioural claim ("the control acknowledges before the destination
// exists", "the tap no longer replaces the document") is proved in the browser
// by e2e/resp-client-intake-01-nav-ack.spec.ts. This file pins the two things a
// browser run localises poorly: WHICH controls were converted, and — just as
// important — which deliberately were NOT.
//
// WHY COMMENTS ARE STRIPPED FIRST
// -------------------------------
// The conversion commentary in these files quotes the very tokens this suite
// scans for: it says "this was a raw <a>" and "it is a real <Link>". A scan over
// raw source would match that prose and report a defect that does not exist —
// or, worse, keep reporting one after a real fix. LINE comments are stripped
// BEFORE block comments, which is the order this repository already learned the
// hard way on the marketing content guards.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const codeOnly = (source: string) =>
  source
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const PROFILE = "app/(app)/clients/[id]/page.tsx";
const INTAKE = "app/(app)/clients/[id]/intake/page.tsx";
const HISTORY = "app/(app)/clients/[id]/intake/IntakeHistoryList.tsx";
const TABBAR = "components/profile-tab-bar.tsx";

const ALL = [PROFILE, INTAKE, HISTORY, TABBAR] as const;

/** Every control converted by this slice, with the label it must announce. */
const CONVERTED = [
  { file: PROFILE, href: "/sessions/new`", label: "Opening new session…", count: 1 },
  { file: PROFILE, href: "?tab=consultation`", label: "Opening consultation…", count: 1 },
  { file: PROFILE, href: "/intake`", label: "Opening intake…", count: 3 },
  { file: PROFILE, href: "/sessions/${lastTreatment.id}`", label: "Opening session…", count: 1 },
  { file: TABBAR, href: "${pathname}/images`", label: "Opening treatment photos…", count: 2 },
  { file: INTAKE, href: "/clients/${id}`", label: "Opening client…", count: 2 },
  { file: HISTORY, href: "?intake=${row.id}`", label: "Opening intake version…", count: 1 },
] as const;

describe("RESP-CLIENT-INTAKE-01: every converted control uses the shipped leaf", () => {
  for (const file of ALL) {
    it(`${file} imports the navigation primitive`, () => {
      expect(read(file)).toContain('from "@/components/pending-link"');
    });
  }

  for (const row of CONVERTED) {
    it(`${row.file} announces "${row.label}" for ${row.href}`, () => {
      const code = codeOnly(read(row.file));
      expect(code).toContain(`pendingLabel="${row.label}"`);
      const labels = code.match(
        new RegExp(`pendingLabel="${row.label}"`, "g"),
      );
      expect(labels ?? []).toHaveLength(row.count);
    });
  }

  it("every converted control is the LABEL form, never the container form", () => {
    // Every one of these controls' children is a text label, not a flex/grid
    // arrangement, so PendingLink is correct and PendingContainerLink would be
    // wrong. Choosing the container form here would silently change geometry.
    //
    // The expected total is DERIVED from the table above rather than restated,
    // so adding a row cannot leave a stale number agreeing with itself.
    const expected = CONVERTED.reduce((n, row) => n + row.count, 0);
    const total = ALL.map((f) => codeOnly(read(f)))
      .map((c) => (c.match(/<PendingLink\b/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(expected);
    for (const f of ALL) {
      expect(codeOnly(read(f))).not.toContain("<PendingContainerLink");
    }
  });
});

describe("RESP-CLIENT-INTAKE-01: the two raw anchors are gone", () => {
  it("neither converted file routes an in-app URL through a raw <a>", () => {
    // The defect: a raw <a> to an in-app URL leaves the client router, so the
    // tap replaces the whole document. Measured before the fix as 0 RSC / 1
    // document request with the live document destroyed.
    for (const file of [PROFILE, HISTORY]) {
      const code = codeOnly(read(file));
      const rawInternal = [
        ...code.matchAll(/<a\b[^>]*?href=\{?[`"]\/[^`"]*/g),
      ].map((m) => m[0]);
      expect(rawInternal, `${file} still has a raw internal <a>`).toEqual([]);
    }
  });

  it("the client profile keeps its ONE legitimate raw anchor — tel:", () => {
    // Anti-overreach. `telHref(...)` is not an in-app navigation and must NOT
    // become a <Link>; a guard that simply banned every <a> would have deleted
    // a working phone link and called it a fix.
    const code = codeOnly(read(PROFILE));
    expect(code).toContain("telHref(");
    const anchors = code.match(/<a\b/g) ?? [];
    expect(anchors).toHaveLength(1);
  });

  it("both converted hrefs are preserved byte-for-byte", () => {
    expect(codeOnly(read(PROFILE))).toContain(
      "href={`/clients/${client.id}?tab=consultation`}",
    );
    expect(codeOnly(read(HISTORY))).toContain(
      "href={`/clients/${clientId}/intake?intake=${row.id}`}",
    );
  });
});

describe("RESP-CLIENT-INTAKE-01: the slice did not grow", () => {
  it("the three unmeasured Client Profile links are still bare <Link>", () => {
    // /clients (back to the list) and the two Edit links were NOT in the
    // measured slice. Converting them would be the blanket adoption this work
    // is scoped against, and would make the PR unreviewable against its brief.
    const code = codeOnly(read(PROFILE));
    expect(code).toContain('href="/clients"');
    expect(code).toMatch(/<Link\s+href="\/clients"/);
    const edits = code.match(/<Link\s+href=\{`\/clients\/\$\{client\.id\}\/edit`\}/g);
    expect(edits ?? []).toHaveLength(2);
  });

  it("the two unmeasured Intake links are still bare <Link>", () => {
    const code = codeOnly(read(INTAKE));
    expect(code).toMatch(/<Link\s+href=\{`\/clients\/\$\{id\}\/intake`\}/);
    expect(code).toMatch(
      /<Link\s+href=\{`\/clients\/\$\{id\}\/intake\/assist\?intake=\$\{intake\.id\}`\}/,
    );
  });

  it("the tab bar's own button vocabulary was NOT replaced", () => {
    // The seven tab controls are <button>s that own their own transition; they
    // keep the local copy. Only the Treatment Photos LINK moved to the shipped
    // primitive. Deleting the local copy would silence the tabs.
    const code = codeOnly(read(TABBAR));
    expect(code).toContain("PENDING_MARK");
    expect(code).toContain("useTransition()");
    expect(code).toMatch(/aria-busy=\{isPendingTarget \|\| undefined\}/);
  });

  it("pending-link.tsx itself is untouched — this slice only adopts it", () => {
    const src = read("components/pending-link.tsx");
    expect(src.match(/^export function Pending/gm) ?? []).toHaveLength(2);
    expect(src).not.toContain("useState");
    expect(src).not.toContain("useEffect");
    expect(src).not.toContain("useTransition");
  });
});

describe("RESP-CLIENT-INTAKE-01: the live region names the destination", () => {
  it("every label describes the REQUEST, never the outcome", () => {
    for (const row of CONVERTED) {
      expect(row.label).toMatch(/^Opening /);
      expect(row.label).not.toMatch(/opened|loaded|done/i);
    }
  });

  it("labels are distinct per destination", () => {
    // Two controls may share a label only when they reach the SAME route: the
    // three "View intake" branches, the two back links, the two photo forms.
    // A shared label across DIFFERENT routes would make the announcement a lie.
    const byLabel = new Map<string, Set<string>>();
    for (const row of CONVERTED) {
      if (!byLabel.has(row.label)) byLabel.set(row.label, new Set());
      byLabel.get(row.label)!.add(row.href);
    }
    for (const [label, hrefs] of byLabel) {
      expect(hrefs.size, `"${label}" is used for more than one destination`).toBe(1);
    }
  });
});
