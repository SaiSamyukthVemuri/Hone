import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

// Permanent source guards for Willow PR A, dedicated consultation +
// skin/hair analysis clinical notes (migration 0126). These pin the safety
// contract that the DB tests cannot see: the feature is authenticated
// practitioner-only, RLS-scoped, append-only, and never wired into any portal,
// public-booking, email, SMS, cron, or Stripe surface.

const ROOT = path.resolve(__dirname, "../..");

function read(rel: string): string {
  const full = path.join(ROOT, rel);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

// Strip line + block comments so "must NOT contain" assertions test CODE, not
// the safety prose in the file's own comments (which deliberately names the very
// surfaces we forbid importing).
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const base = path.join(ROOT, dir);
  if (!existsSync(base)) return out;
  for (const entry of readdirSync(base)) {
    const full = path.join(base, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...listFiles(path.relative(ROOT, full)));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(path.relative(ROOT, full));
    }
  }
  return out;
}

const ACTIONS = "app/(app)/clients/[id]/clinical-notes-actions.ts";
const QUERIES = "lib/clinical-notes/queries.ts";
const SECTION = "components/clinical-notes-section.tsx";
const SUMMARY = "components/clinical-notes-summary.tsx";
const PRINT = "app/(app)/clients/[id]/clinical-notes/print/page.tsx";
const SECTION_DATA = "lib/clinical-notes/section-data.ts";

// Every server-side file in the clinical-notes feature. The append-only DELETE
// contract (0126) allows service_role/postgres hard-delete only for controlled
// admin/tenant-teardown; the APPLICATION note paths must therefore never reach
// for the service-role/admin client, they use the RLS-scoped user client so
// authenticated practitioners can neither UPDATE nor DELETE.
const CLINICAL_SERVER_FILES = [ACTIONS, QUERIES, SECTION_DATA, PRINT];

describe("clinical-notes server actions: trust boundary", () => {
  const src = read(ACTIONS);
  const bare = code(ACTIONS);

  it("run under the RLS-scoped user client, never the admin/service-role client", () => {
    expect(src).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(bare).not.toMatch(/createAdminClient|service_role|SUPABASE_SERVICE_ROLE/i);
  });

  it("force the author + studio from auth (never trust the form's practitioner/studio)", () => {
    expect(src).toMatch(/getCurrentPractitionerWithStudio/);
    expect(src).toMatch(/practitioner_id: practitioner\.id/);
  });

  it("verify the persisted row with a SEPARATE read-back before reporting success", () => {
    // A distinct SELECT by the inserted id, and the success path is gated on it.
    expect(src).toMatch(/\.eq\("id", inserted\.id\)/);
    expect(src).toMatch(/could not be confirmed|Could not verify/i);
  });

  it("map the supersedes unique-violation to a distinct stale-revision conflict (no silent duplicate retry)", () => {
    expect(src).toMatch(/23505/);
    expect(src).toMatch(/stale_revision/);
    // The stale-revision branch returns a conflict result (no auto-resubmit that
    // could create a duplicate clinical record).
    expect(bare).toMatch(/stale_revision"[\s\S]{0,120}ok: false|ok: false[\s\S]{0,160}stale_revision/);
  });

  it("do not import email / SMS / Stripe / portal / booking surfaces", () => {
    const imports = bare.match(/from ["'][^"']+["']/g) ?? [];
    for (const imp of imports) {
      expect(imp).not.toMatch(/lib\/email|lib\/sms|stripe|app\/book|portal/i);
    }
  });
});

describe("clinical-notes reads stay RLS-scoped and server-only", () => {
  it("the query module is server-only and uses the user client", () => {
    const src = read(QUERIES);
    expect(src).toMatch(/^import "server-only";/m);
    expect(src).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(code(QUERIES)).not.toMatch(/service_role|createAdminClient/i);
  });
});

describe("application note paths never use the admin/service-role client", () => {
  // The admin client factory is createAdminClient() from lib/supabase/admin-server.
  // No clinical-notes server file may import it or otherwise reach for the
  // service role, that capability is reserved for controlled admin/teardown
  // paths, not the practitioner-facing note actions/reads.
  for (const rel of CLINICAL_SERVER_FILES) {
    it(`${rel} does not import or instantiate the admin/service-role client`, () => {
      const bare = code(rel);
      expect(bare).not.toMatch(/createAdminClient/);
      expect(bare).not.toMatch(/lib\/supabase\/admin-server/);
      expect(bare).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE/i);
    });
  }
});

describe("no cross-surface leakage (import audit)", () => {
  const FORBIDDEN_DIRS = [
    "app/book",
    "app/intake",
    "app/cancel",
    "app/reschedule",
    "app/api/cron",
    "app/api/stripe",
    "lib/email",
  ];
  // Any module that mentions a portal/public/email/sms/booking surface must not
  // pull in the clinical-notes feature modules.
  const TARGETS = [
    "clinical-notes-actions",
    "clinical-notes-section",
    "clinical-notes-summary",
    "clinical-notes/queries",
    "clinical-notes/section-data",
  ];

  for (const dir of FORBIDDEN_DIRS) {
    it(`${dir} does not import any clinical-notes module`, () => {
      for (const rel of listFiles(dir)) {
        const src = read(rel);
        for (const t of TARGETS) {
          expect(src.includes(t)).toBe(false);
        }
      }
    });
  }

  it("the portal app tree does not import clinical-notes modules", () => {
    const portal = listFiles("app/(portal)").concat(listFiles("app/portal"));
    for (const rel of portal) {
      const src = read(rel);
      for (const t of TARGETS) {
        expect(src.includes(t)).toBe(false);
      }
    }
  });
});

describe("surfaces + placement", () => {
  it("the print/export route lives under the authenticated app tree", () => {
    expect(existsSync(path.join(ROOT, PRINT))).toBe(true);
    expect(PRINT.startsWith("app/(app)/")).toBe(true);
  });

  it("the profile tab set includes a dedicated consultation tab", () => {
    const tab = read("components/profile-tab.ts");
    expect(tab).toMatch(/"consultation"/);
    const bar = read("components/profile-tab-bar.tsx");
    expect(bar).toMatch(/value: "consultation"/);
  });

  it("the section + summary + print components render note bodies as pre-wrapped text", () => {
    expect(read(SECTION)).toMatch(/whitespace-pre-wrap/);
    expect(read(SUMMARY)).toMatch(/whitespace-pre-wrap/);
    expect(read(PRINT)).toMatch(/whitespace-pre-wrap/);
  });
});
