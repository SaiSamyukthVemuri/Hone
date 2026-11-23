import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildCardChangeNotification } from "@/lib/billing/card-change-notification";
import { WAITLIST_OFFER_DECLINED_BODY, WAITLIST_OFFER_DECLINED_TITLE } from "@/lib/notifications/waitlist-offer-declined";

// Privacy rule (RLS lets every studio member READ every row of practitioner_notifications, and until the UPDATE policy is column-limited any member can
// rewrite one), so what a notification SAYS must stay minimal. A notification may carry: the client's display name, a service name, a time, a staff
// display name, and for owner-only card events a brand and last four. It must NEVER carry a block's private note, a legal name, clinical text or an
// intake answer. This pins the SOURCE of every writer's title/body, so a new field cannot be added to a message without failing here.

const WRITER_CALL = /\b(recordPractitionerNotification|recordPractitionerNotificationAndWait|ensurePractitionerNotification)\(\s*(?:admin\s*,\s*)?\{/g;

// Every file that writes a notification from application code. A NEW writer must be added here on purpose, with its content reviewed.
const EXPECTED_WRITER_FILES = [
  "app/book/[slug]/actions.ts",
  "app/intake/[token]/actions.ts",
  "app/portal/rebook-actions.ts",
  "app/reschedule/[token]/actions.ts",
  "lib/billing/card-change-notification.ts",
  "lib/notifications/appointment-cancel-notification.ts",
];

// Identifiers and words whose presence in a title/body expression means private or clinical content is being interpolated.
const FORBIDDEN = [
  /legal[_ ]?name/i,
  /private[_ ]?note/i,
  /\bnote(s)?\b/i, // block notes, clinical notes, client notes, consultation notes
  /clinical/i,
  /chart/i,
  /intake[_ ]?(answers?|responses?|data)/i,
  /\banswers?\b/i,
  /\bresponses?\b/i,
  /diagnos/i,
  /allerg/i,
  /medic/i,
  /health/i,
  /date_of_birth|\bdob\b|birthday/i,
  /\bphone\b|\bemail\b/i,
  /address/i,
  /payload/i,
];

function callBodies(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(WRITER_CALL)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

function titleAndBody(call: string): string {
  // The fields that become visible text. Comments inside the call are not content, so strip them first.
  const stripped = call.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const picked = stripped.split("\n").filter((l) => /^\s*(title|body)\b/.test(l) || /^\s*[`?:"'$]/.test(l) || /^\s+[A-Za-z`"']/.test(l));
  return picked.join("\n");
}

describe("notification content: no private, legal, clinical or intake text", () => {
  it("the set of files that write notifications is exactly the reviewed set", () => {
    const found = execSync(
      "grep -rlE 'recordPractitionerNotification|ensurePractitionerNotification' app lib --include=*.ts --include=*.tsx",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((f) => f !== "lib/notifications/practitioner-notifications.ts")
      .sort();
    expect(found).toEqual([...EXPECTED_WRITER_FILES].sort());
  });

  it("every writer call site was found (so the scan below is not vacuous)", () => {
    let total = 0;
    for (const f of EXPECTED_WRITER_FILES) {
      const n = callBodies(readFileSync(f, "utf8")).length;
      expect(n, f).toBeGreaterThan(0);
      total += n;
    }
    expect(total).toBeGreaterThanOrEqual(7);
  });

  it.each(EXPECTED_WRITER_FILES)("%s: title and body interpolate no forbidden field", (f) => {
    const src = readFileSync(f, "utf8");
    // card-change builds its text in a pure function, scanned separately below; the other files carry it in the call itself.
    for (const call of callBodies(src)) {
      const body = call.match(/\btitle\s*:[\s\S]*?(?=\n\s*(appointmentId|clientId|href|practitionerId|dedupeKey)\b)/)?.[0] ?? "";
      const text = titleAndBody(body);
      for (const re of FORBIDDEN) expect(text, `${f}: ${re}`).not.toMatch(re);
    }
  });

  it("the card-change and waitlist builders carry only the allowed fields", () => {
    const added = buildCardChangeNotification({ clientName: "Pat Example", brand: "visa", last4: "4242", isReplacement: false, clientId: "c1" });
    const replaced = buildCardChangeNotification({ clientName: "Pat Example", brand: "visa", last4: "4242", isReplacement: true, clientId: "c1" });
    for (const n of [added, replaced]) {
      expect(`${n.title} ${n.body}`).toMatch(/Pat Example/);
      for (const re of FORBIDDEN) expect(`${n.title} ${n.body}`).not.toMatch(re);
      expect(n.href).toBe("/clients/c1?tab=billing");
    }
    expect(WAITLIST_OFFER_DECLINED_BODY).toBe("");
    // A fixed sentence that names no one (the word "response" here is the product's own wording, not a field).
    expect(WAITLIST_OFFER_DECLINED_TITLE).toBe("A waitlist response needs your attention");
  });

  it("the SQL writers of notification text (0325) carry a fixed title and an empty body", () => {
    const sql = readFileSync("supabase/migrations/0325_waitlist_decline_followups.sql", "utf8");
    const inserts = [...sql.matchAll(/insert into public\.practitioner_notifications[^;]*?values\s*\(([^;]*?)\)\s*on conflict/gis)];
    expect(inserts.length).toBe(2);
    for (const m of inserts) {
      expect(m[1]).toContain("'A waitlist response needs your attention', ''");
    }
  });

  it("negative control: the forbidden list does catch each private-field spelling", () => {
    const bad = ["${block.private_note}", "${client.legal_name}", "${intake.answers}", "${chart.clinical_notes}", "${client.date_of_birth}", "${client.email}"];
    for (const s of bad) expect(FORBIDDEN.some((re) => re.test(s)), s).toBe(true);
  });
});

// Condition (b): the only person-name a notification may carry is the DISPLAY name, the field the calendar shows (clientDisplayName: the preferred name
// where set, else the stored clients.name). A writer must never read the legal-identity columns or helper, even to build a name. Checked over each
// writer file's whole source (imports included) so a read anywhere in the file fails.
const LEGAL_IDENTITY_READS = [
  /legal_given_name|legal_middle_name|legal_family_name|legal_full_name/i,
  /legal[_ ]?name|legalName/i,
  /legal-identity/i,
  /\b(readLegalIdentity|readLegalNamesForStudio|readLegalNamesForClients|LEGAL_IDENTITY_COLUMNS|LegalIdentityRow)\b/,
  /client_legal_identit/i,
];

describe("notification writers never read legal identity (display name only)", () => {
  it.each(EXPECTED_WRITER_FILES)("%s reads no legal-identity column or helper", (f) => {
    const src = readFileSync(f, "utf8").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const re of LEGAL_IDENTITY_READS) expect(src, `${f}: ${re}`).not.toMatch(re);
  });

  it("the shared writer module reads none either", () => {
    const src = readFileSync("lib/notifications/practitioner-notifications.ts", "utf8").replace(/\/\/[^\n]*/g, "");
    for (const re of LEGAL_IDENTITY_READS) expect(src).not.toMatch(re);
  });

  it("negative control: each legal-identity spelling is caught", () => {
    const bad = ["select('legal_given_name')", "import { readLegalIdentity } from '@/lib/clients/legal-identity'", "client.legalName", "readLegalNamesForClients(x)"];
    for (const s of bad) expect(LEGAL_IDENTITY_READS.some((re) => re.test(s)), s).toBe(true);
  });
});
