import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// HON-58 slice 4 wiring contract (source level; the behaviour is proved in the
// unit suites and, once the migration exists, in tests/db and the browser lane).
// It pins WHICH identity each kind of surface uses, so a later edit cannot move
// the legal name onto an ordinary surface or the preferred name onto an insurer
// document without this failing.

const read = (p: string) => readFileSync(p, "utf8");

const ORDINARY_DISPLAY = [
  "app/(app)/clients/ArchivedClientsList.tsx",
  "app/(app)/calendar/QuickBookDrawer.tsx",
  "app/(app)/calendar/upcoming/page.tsx",
  "app/(app)/dashboard/page.tsx",
  "components/client-search.tsx",
  "lib/booking/queries.ts",
];

describe("ordinary staff surfaces show the display name, never a legal-name read", () => {
  it.each(ORDINARY_DISPLAY)("%s uses clientDisplayName/clientIdentityPair and reads no legal identity", (file) => {
    const src = read(file);
    expect(src).toMatch(/clientDisplayName|clientIdentityPair/);
    expect(src).not.toMatch(/client_legal_identities|readLegalIdentity|readLegalNamesFor/);
  });
});

describe("only authorized, signed-in paths read legal identity", () => {
  const READERS = [
    "app/(app)/clients/page.tsx",
    "app/(app)/clients/[id]/page.tsx",
    "app/(app)/clients/[id]/edit/page.tsx",
    "app/(app)/clients/[id]/clinical-notes/print/page.tsx",
    "app/(app)/global-search-actions.ts",
    "app/(app)/clients/[id]/legal-identity-actions.ts",
  ];
  it.each(READERS)("%s uses the signed-in client and never the admin client", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/createAdminClient|admin-server/);
    expect(src).toMatch(/createClient/);
  });

  it("no module logs a name field", () => {
    for (const file of [...READERS, "lib/clients/identity.ts", "lib/clients/legal-identity.ts"]) {
      const lines = read(file).split("\n").filter((l) => /console\.(log|error|warn|info)/.test(l));
      for (const line of lines) expect(line).not.toMatch(/legal_(given|middle|family)_name|preferred_name|clientName|\.name\b/);
    }
  });
});

describe("clients communications and documents", () => {
  it("the booking confirmation and postcare emails use the communication name", () => {
    expect(read("app/(app)/calendar/actions.ts")).toMatch(/clientCommunicationName\(client\)/);
    expect(read("app/(app)/calendar/postcare-auto-send.ts")).toMatch(/clientCommunicationName\(client\)/);
  });

  it("the email subject rule is untouched: no template subject takes a client name", () => {
    for (const file of ["lib/email/templates/appointment.ts", "lib/email/templates/reminders.ts", "lib/email/templates/postcare.ts"]) {
      const subjects = read(file).split("\n").filter((l) => /subject/i.test(l));
      for (const line of subjects) expect(line).not.toMatch(/clientName|preferred|legal/i);
    }
  });

  it("the clinical-notes print carries the legal identity with the preferred name beside it (Q2)", () => {
    const src = read("app/(app)/clients/[id]/clinical-notes/print/page.tsx");
    expect(src).toMatch(/clinicalPacketName/);
    expect(src).toMatch(/could not be loaded/); // a failed legal read is said, not hidden
  });
});

describe("no public booking surface collects or reads the new fields (OPS Q3)", () => {
  it("app/book never mentions preferred_name or the legal identity table", () => {
    for (const file of ["app/book/[slug]/actions.ts", "app/book/[slug]/page.tsx"]) {
      expect(read(file)).not.toMatch(/preferred_name|client_legal_identities/);
    }
  });
});
