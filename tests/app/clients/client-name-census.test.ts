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
//   unreviewed  reads a stored name; nobody has yet judged whether the name is already the display name, or whether this is a
//               clinical / insurer-facing surface where the legal identity is the rule. Reducing this set is the work.
type Status = "helper" | "upstream" | "gap" | "unreviewed";

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
  ["app/(app)/calendar/postcare-auto-send.ts", 1, "gap"],
  ["app/(app)/clients/[id]/clinical-notes/print/page.tsx", 1, "unreviewed"],
  ["app/(app)/clients/[id]/images/page.tsx", 1, "gap"],
  ["app/(app)/clients/[id]/intake/assist/page.tsx", 2, "gap"],
  ["app/(app)/clients/[id]/intake/page.tsx", 3, "gap"],
  ["app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", 4, "unreviewed"],
  ["app/(app)/clients/[id]/sessions/new/page.tsx", 2, "unreviewed"],
  ["app/(app)/global-search-actions.ts", 3, "helper"],
  ["app/api/cron/appointment-reminders/route.ts", 3, "unreviewed"],
  ["app/intake/[token]/actions.ts", 2, "unreviewed"],
  ["components/client-search.tsx", 1, "unreviewed"],
  ["lib/billing/card-change-notification.ts", 3, "unreviewed"],
  ["lib/billing/manual-fee-card-view.ts", 1, "unreviewed"],
  ["lib/billing/manual-fee-eligibility.ts", 1, "unreviewed"],
  ["lib/billing/payment-receipt.ts", 3, "helper"],
  ["lib/clients/identity.ts", 2, "helper"],
  ["lib/clients/name-search.ts", 2, "unreviewed"],
  ["lib/clinical-records/insurer-field-gaps.ts", 1, "helper"],
  ["lib/email/send-appointment.ts", 3, "unreviewed"],
  ["lib/notifications/appointment-cancel-notification.ts", 1, "unreviewed"],
  ["lib/record-keeping/queries.ts", 2, "unreviewed"],
];

// Why each "gap" is one: the read in that file selects the stored name and no preferred name, then renders or sends it.
const GAP_EVIDENCE: Record<string, string> = {
  "app/(app)/clients/[id]/images/page.tsx": 'select("id, name, portrait_image_id"), then "← {client.name}"',
  "app/(app)/clients/[id]/intake/page.tsx": 'select("id, name, email"), then "← {client.name}" and "Sitting with {client.name}?"',
  "app/(app)/clients/[id]/intake/assist/page.tsx": 'select("id, name"), then "Complete intake with {client.name}"',
  "app/(app)/calendar/postcare-auto-send.ts": 'select("... client:clients(name, email) ..."), then clientName: client?.name into the client email',
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
    expect(found.has("app/(app)/clients/[id]/images/page.tsx")).toBe(true);
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
