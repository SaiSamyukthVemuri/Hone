import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// HON-58 / Roles: which name does a surface show? Ordinary staff surfaces and client communications show the PREFERRED
// identity (lib/clients/identity.ts: clientDisplayName / clientCommunicationName); only clinical and insurer-facing output
// uses the legal identity. This is a CENSUS RATCHET, not a proof that every surface is right, and it says so:
//
//   WHAT IT SEES. Every source file under app/, components/ and lib/ that reads a client's STORED name by one of the spellings in
//   RAW_NAME (client.name, client?.name, data.client.name, a.client?.name, ...). A name that reaches a surface through a variable
//   with a different spelling is NOT seen. It cannot tell a surface that replaced `name` with the display name upstream from one
//   that did not; the status column records what a person verified.
//
//   WHAT IT ENFORCES. (1) a file that starts reading a stored name must be added here, with a status, by a person; (2) it cannot
//   read it more often than recorded; (3) a recorded file that stops reading it must be removed; (4) the confirmed gaps are an
//   EXACT set, so fixing one cannot leave it listed, and a fix cannot be undone silently.
//
// Statuses:
//   helper      the file imports the identity helpers; its raw reads sit beside them (a person reviewed the file with the helper in it)
//   upstream    the surface draws a name its loader already replaced with the display name; pinned by calendar-display-name-surfaces.test.ts
//   gap         CONFIRMED: renders the stored name on a staff surface or in a client communication although a preferred name may exist
//               (the read selects the stored name only). Evidence in GAP_EVIDENCE. These are findings, not accepted behaviour.
//   unrendered  the stored name is PASSED but the output never renders it (so nothing is shown); pinned by the test named in
//               UNRENDERED_EVIDENCE, which fails if a greeting is ever added. Which name a future greeting uses is a product rule.
//   fine        reviewed: correct as it is, for the reason in FINE_REASON
//   unreviewed  reads a stored name; nobody has yet judged whether the name is already the display name, or whether this is a
//               clinical / insurer-facing surface where the legal identity is the rule. Reducing this set is the work.
type Status = "helper" | "upstream" | "gap" | "unrendered" | "fine" | "unreviewed";

const RAW_NAME =
  /\bclient\??\.name\b|\bclientData\.client\.name\b|\bdata\??\.client\??\.name\b|\ba\.client\?\.name\b|\bp\.client\.name\b|\be\.client\?\.name\b/g;
const HELPER = /clientDisplayName|clientCommunicationName|clientClinicalName|clientIdentityPair|lib\/clients\/(identity|print-identity|profile-name)/;

const BASELINE: ReadonlyArray<readonly [string, number, Status]> = [
  ["app/(app)/calendar/AppointmentOverlapChooser.tsx", 1, "upstream"],
  ["app/(app)/calendar/AppointmentPreviewDrawer.tsx", 2, "upstream"],
  ["app/(app)/calendar/DayColumn.tsx", 1, "upstream"],
  ["app/(app)/calendar/MobileDayTimeline.tsx", 1, "upstream"],
  ["app/(app)/calendar/[id]/page.tsx", 3, "helper"],
  ["app/(app)/calendar/actions.ts", 4, "helper"],
  ["app/(app)/calendar/check-practitioner/page.tsx", 1, "helper"],
  ["app/(app)/calendar/postcare-auto-send.ts", 1, "unrendered"],
  ["app/(app)/clients/[id]/clinical-notes/print/page.tsx", 1, "gap"],
  ["app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", 1, "fine"],
  ["app/(app)/global-search-actions.ts", 3, "helper"],
  ["app/api/cron/appointment-reminders/route.ts", 3, "gap"],
  ["app/intake/[token]/actions.ts", 2, "gap"],
  ["components/client-search.tsx", 1, "unreviewed"],
  ["lib/billing/card-change-notification.ts", 3, "gap"],
  ["lib/billing/manual-fee-card-view.ts", 1, "gap"],
  ["lib/billing/manual-fee-eligibility.ts", 1, "gap"],
  ["lib/billing/payment-receipt.ts", 3, "helper"],
  ["lib/clients/identity.ts", 2, "helper"],
  ["lib/clients/name-search.ts", 2, "fine"],
  ["lib/clinical-records/insurer-field-gaps.ts", 1, "helper"],
  ["lib/email/send-appointment.ts", 3, "gap"],
  ["lib/notifications/appointment-cancel-notification.ts", 1, "gap"],
  ["lib/record-keeping/queries.ts", 2, "unreviewed"],
];

// Why each "gap" is one. Confirmed by reading the file; NOT fixed in the PR that records them (each is a separate decision or change).
const GAP_EVIDENCE: Record<string, string> = {
  "app/(app)/clients/[id]/clinical-notes/print/page.tsx": "clinical output prints the stored name; the rule is the legal identity (clientClinicalName) when one is set",
  "app/api/cron/appointment-reminders/route.ts": "LIVE client-facing: the treatment-time line renders \"<first word of the STORED name>'s first electrolysis session\" in the reminder email when the studio shows treatment time (lib/treatment-time/format.ts:64)",
  "lib/email/send-appointment.ts": "LIVE client-facing: same treatment-time line, first word of the stored name (line ~953)",
  "app/intake/[token]/actions.ts": 'staff notification "<stored name> submitted an intake form."',
  "lib/billing/card-change-notification.ts": "staff notification names the client by the stored name (select name only)",
  "lib/notifications/appointment-cancel-notification.ts": "staff notification names the client by the stored name (reads name only)",
  "lib/billing/manual-fee-card-view.ts": "owner-facing fee card shows the client by the stored name",
  "lib/billing/manual-fee-eligibility.ts": "reads client:clients(id, name) and hands the stored name to the fee card",
};
const UNRENDERED_EVIDENCE: Record<string, string> = {
  "app/(app)/calendar/postcare-auto-send.ts": "tests/app/calendar/calendar-communication-preview-name.test.ts (the postcare email renders no client name; the send is pinned to the stored name so preview and send agree)",
};
const FINE_REASON: Record<string, string> = {
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx": "the one remaining read feeds the postcare PREVIEW, which is pinned to the stored name so it matches the send; the page's screen wording uses clientDisplayName",
  "lib/clients/name-search.ts": "search deliberately matches BOTH the stored and the preferred name (tests/lib/clients/name-search.test.ts)",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".next") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}

const found = new Map<string, number>();
for (const dir of ["app", "components", "lib"]) {
  for (const f of walk(dir)) {
    const n = (readFileSync(f, "utf8").match(RAW_NAME) ?? []).length;
    if (n > 0) found.set(f, n);
  }
}
const recorded = new Map(BASELINE.map(([f, n]) => [f, n] as const));

describe("client-name census: which files read a stored client name", () => {
  it("the census sees files at all (a broken pattern must not pass as 'nothing found')", () => {
    expect(found.size).toBeGreaterThan(15);
    expect(found.has("app/api/cron/appointment-reminders/route.ts")).toBe(true);
  });

  it("no file reads a stored client name that is not recorded here, with a status chosen by a person", () => {
    const unrecorded = [...found.keys()].filter((f) => !recorded.has(f));
    expect(unrecorded, "new raw client-name read: use clientDisplayName / clientCommunicationName, or record it with a status").toEqual([]);
  });

  it("no file reads it more often than recorded", () => {
    const over = BASELINE.filter(([f, n]) => (found.get(f) ?? 0) > n).map(([f, n]) => `${f}: ${found.get(f)} > ${n}`);
    expect(over).toEqual([]);
  });

  it("a recorded file that no longer reads a stored name, or reads it less, is updated here (the record cannot go stale)", () => {
    const stale = BASELINE.filter(([f, n]) => (found.get(f) ?? 0) < n).map(([f, n]) => `${f}: now ${found.get(f) ?? 0}, recorded ${n}`);
    expect(stale).toEqual([]);
  });
});

describe("statuses are true of the files they are attached to", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  it('"helper" files really import the identity helpers', () => {
    for (const [f, , s] of BASELINE) if (s === "helper") expect(HELPER.test(read(f)), f).toBe(true);
  });

  it('"gap" files are exactly the confirmed set, each with its evidence, and none has been given a helper (a fixed one must be reclassified)', () => {
    const gaps = BASELINE.filter(([, , s]) => s === "gap").map(([f]) => f).sort();
    expect(gaps).toEqual(Object.keys(GAP_EVIDENCE).sort());
    for (const f of gaps) expect(HELPER.test(read(f)), `${f} now uses a helper: reclassify it`).toBe(false);
  });

  it('"unrendered" and "fine" files are exactly their recorded sets, with the evidence in place', () => {
    const of = (s: Status) => BASELINE.filter(([, , x]) => x === s).map(([f]) => f).sort();
    expect(of("unrendered")).toEqual(Object.keys(UNRENDERED_EVIDENCE).sort());
    expect(of("fine")).toEqual(Object.keys(FINE_REASON).sort());
    // the postcare template must still render no client name (one occurrence: the type), and its pin test must still exist
    const tpl = read("lib/email/templates/postcare.ts");
    expect((tpl.match(/clientName/g) ?? []).length, "the postcare template now uses clientName: decide which name it greets with, then reclassify").toBe(1);
    expect(read("tests/app/calendar/calendar-communication-preview-name.test.ts")).toContain("does not render the client's name today");
  });

  it('"upstream" files are the calendar components the existing display-name test pins, and they read no second name field', () => {
    for (const [f, , s] of BASELINE) {
      if (s !== "upstream") continue;
      expect(f.startsWith("app/(app)/calendar/"), f).toBe(true);
      const src = read(f);
      expect(src).not.toMatch(/preferred_name|preferredName/);
      expect(src).not.toMatch(/legal/i);
    }
  });

  it("the legal identity is read only where the rule allows: a closed list of files (a new reader must be added here on purpose)", () => {
    const LEGAL = /\blegal_(given_name|middle_name|family_name|name)\b/;
    const ALLOWED = new Set([
      "app/(app)/clients/[id]/edit/page.tsx",
      "app/(app)/clients/[id]/legal-identity-actions.ts",
      "app/(app)/records/print/page.tsx",
      "components/intake/intake-question-field.tsx",
      "components/legal-identity-form.tsx",
      "lib/clients/identity.ts",
      "lib/clients/legal-identity.ts",
      "lib/clients/name-search.ts",
      "lib/clients/print-identity.ts",
      "lib/clinical-records/insurer-field-gaps.ts",
      "lib/intake/questions.ts",
      "lib/observability/sentry-scrub.ts",
    ]);
    const readers: string[] = [];
    for (const dir of ["app", "components", "lib"]) for (const f of walk(dir)) if (LEGAL.test(read(f))) readers.push(f);
    expect(readers.sort()).toEqual([...ALLOWED].sort());
  });
});
