import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClientForm } from "@/components/client-form";

// Codex P1 4476375636 (calendar/[id]/page.tsx:117): once clin.view_records is released and an owner turns it Off for a role, skin type
// (clients.fitzpatrick_type) and legacy skin notes (clients.skin_notes) must disappear from every surface that read or rendered them: the
// appointment briefing, the client Overview, the edit page and form, and the write path. Catalog DN-5: skin type, skin notes and treatment
// goals are part of the clinical record.

const read = (p: string) => readFileSync(p, "utf8");
const walkFiles = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
};

vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: vi.fn(async () => ({ allowed: true, mode: "enforce", engine: true })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = new Proxy(chain, {
        get(_t, prop: string) {
          if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null });
          if (prop === "maybeSingle")
            return async () => ({ data: table === "clients" ? { id: "c1", name: "Synthetic Client", fitzpatrick_type: 3, skin_notes: "SYNTHETIC-SKIN-NOTE" } : null, error: null });
          return () => self;
        },
      });
      return self;
    },
  }),
}));

describe("getClientById: the clinical-record fields follow the gate", () => {
  it("a refused gate returns skin type and skin notes as null (the viewer never receives them)", async () => {
    const { getClientById } = await import("@/lib/supabase/queries");
    const data = await getClientById("s1", "c1", { includePrices: false, includeSessions: false, clinicalFields: async () => false });
    expect(data?.client.fitzpatrick_type).toBeNull();
    expect(data?.client.skin_notes).toBeNull();
    expect(data?.client.name).toBe("Synthetic Client");
  });
  it("NEGATIVE CONTROL: an allowed gate carries both unchanged", async () => {
    const { getClientById } = await import("@/lib/supabase/queries");
    const allowed = await getClientById("s1", "c1", { includePrices: false, includeSessions: false, clinicalFields: async () => true });
    expect(allowed?.client.fitzpatrick_type).toBe(3);
    expect(allowed?.client.skin_notes).toBe("SYNTHETIC-SKIN-NOTE");
    const plain = await getClientById("s1", "c1", { includePrices: false, includeSessions: false, clinicalFields: true });
    expect(plain?.client.fitzpatrick_type).toBe(3);
  });
  it("DENY by default (Insurance S-1): a caller that does not pass clinicalFields gets both as null", async () => {
    const { getClientById } = await import("@/lib/supabase/queries");
    const none = await getClientById("s1", "c1", { includePrices: false, includeSessions: false });
    expect(none?.client.fitzpatrick_type).toBeNull();
    expect(none?.client.skin_notes).toBeNull();
    const bare = await getClientById("s1", "c1");
    expect(bare?.client.fitzpatrick_type).toBeNull();
    expect(bare?.client.skin_notes).toBeNull();
  });
});

describe("the appointment briefing does not select or render the fields without clin.view_records", () => {
  const SRC = read("app/(app)/calendar/[id]/page.tsx");
  it("the select names the two columns only when the gate allowed", () => {
    expect(SRC).toContain('${canViewRecords ? ", fitzpatrick_type, skin_notes" : ""}');
    expect(SRC).not.toMatch(/allergies, fitzpatrick_type, skin_notes\)/);
  });
  it("the label is computed only when the gate allowed", () => {
    expect(SRC).toContain("const fitzpatrick = canViewRecords ? fitzpatrickLabel(data.client?.fitzpatrick_type ?? null) : null;");
    expect(SRC.indexOf("const canViewRecords")).toBeLessThan(SRC.indexOf('.from("appointments")'));
  });
});

describe("the client Overview renders them only for a viewer who may see records", () => {
  const SRC = read("app/(app)/clients/[id]/page.tsx");
  it("the read carries the SAME decision as the sessions gate", () => {
    expect(SRC).toContain("clinicalFields: recordsGate");
  });
  it("the practitioner-confirmed skin type and the legacy skin notes are guarded at render", () => {
    expect(SRC).toContain('canViewRecords ? fitzpatrickLabel(client.fitzpatrick_type) : "Not available to your role"');
    expect(SRC).toContain("{canViewRecords && client.skin_notes && (");
  });
});

describe("the edit page and form", () => {
  it("the page asks the gate before reading, and passes the answer to the form", () => {
    const SRC = read("app/(app)/clients/[id]/edit/page.tsx");
    expect(SRC).toContain('clinicalFields: async () => {');
    expect(SRC).toContain('"clin.view_records", { client: id }');
    expect(SRC).toContain("showSkinType={canViewRecords}");
  });
  const props = { submitLabel: "Save", pendingLabel: "Saving", cancelHref: "/x", action: async () => undefined };
  it("the form omits the Fitzpatrick field when not allowed", () => {
    expect(renderToStaticMarkup(createElement(ClientForm, { ...props, showSkinType: false }))).not.toContain("Fitzpatrick type");
  });
  it("NEGATIVE CONTROL: the form shows it by default and when allowed", () => {
    expect(renderToStaticMarkup(createElement(ClientForm, { ...props }))).toContain("Fitzpatrick type");
    expect(renderToStaticMarkup(createElement(ClientForm, { ...props, showSkinType: true }))).toContain("Fitzpatrick type");
  });
  it("a form that never showed the field does not send it", () => {
    expect(read("components/client-form.tsx")).toContain('if (!showSkinType) fd.delete("fitzpatrick_type");');
  });
});

describe("the write path cannot blank or set a value the viewer may not see", () => {
  it("edit: the field is dropped from the patch and the compare-and-write condition unless clin.view_records allows", () => {
    const SRC = read("app/(app)/clients/[id]/actions.ts");
    expect(SRC).toContain('if ("fitzpatrick_type" in plan.patch) {');
    expect(SRC).toContain('"clin.view_records", { client: clientId })).allowed');
    expect(SRC).toContain("delete plan.patch.fitzpatrick_type;");
    expect(SRC).toContain('plan.conditions.findIndex((c) => c.key === "fitzpatrick_type")');
    // the drop happens before the conditional write and before the conflict echo, so a refused viewer's conflict panel never carries it
    expect(SRC.indexOf("delete plan.patch.fitzpatrick_type;")).toBeLessThan(SRC.indexOf('supabase.rpc("update_client_profile_if_unchanged"'));
    // a changed-fields-only plan never selects a key the form did not submit, so a form that omits the field cannot blank it
    expect(read("lib/clients/profile-baseline.ts")).toContain("if (!formData.has(key)) continue;");
  });
  it("create: skin type is not written for a viewer who may not see records", () => {
    const SRC = read("app/(app)/clients/new/actions.ts");
    expect(SRC).toContain("fitzpatrick_type: skinTypeWritable ? nullableInt(formData.get(\"fitzpatrick_type\")) : null");
  });
});

describe("source guard: every client-row reader is gated (Insurance S-1, Privacy EW-2)", () => {
  const QUERIES = read("lib/supabase/queries.ts");
  it("getClientById defaults to DENY", () => {
    expect(QUERIES).toContain("options.clinicalFields === true");
    expect(QUERIES).not.toContain("options.clinicalFields !== false");
  });
  it("the wildcard roster reader with no caller stays deleted", () => {
    expect(QUERIES).not.toContain("export async function getTodayRosterForStudio");
  });
  it("no wildcard client embed or client select(\"*\") exists outside getClientById", () => {
    const hits = ["app", "lib", "components"]
      .flatMap((d) => walkFiles(d))
      .filter((f) => /client:clients\(\*\)|clients\(\*\)/.test(read(f)));
    expect(hits).toEqual([]);
    const beforeGetClientById = QUERIES.slice(0, QUERIES.indexOf("export async function getClientById"));
    expect(beforeGetClientById).not.toMatch(/from\("clients"\)[\s\S]{0,80}select\("\*"\)/);
  });
});

// "Grep for other client-row clinical fields": every source file that names either column is listed here and was reviewed for the gate. A
// new surface that reads or renders them fails this test until it is reviewed and added.
describe("no unreviewed surface reads or renders the two columns", () => {
  const REVIEWED = new Set([
    "app/(app)/calendar/[id]/page.tsx", // gated: select and render
    "app/(app)/clients/[id]/page.tsx", // gated: getClientById clinicalFields + render
    "app/(app)/clients/[id]/edit/page.tsx", // gated: getClientById clinicalFields + form
    "app/(app)/clients/[id]/actions.ts", // write gated
    "app/(app)/clients/new/actions.ts", // write gated
    "components/client-form.tsx", // field shown only with showSkinType
    "app/(app)/settings/data/actions.ts", // owner-only export of the studio's own data (the owner holds every permission)
    "app/(app)/calendar/actions.ts", // comment only
    "lib/types/database.ts",
    "lib/export/resource-registry.ts",
    "lib/intake/fitzpatrick.ts", // self-reported intake estimate: governed by clin.view_intake
    "lib/intake/questions.ts",
    "app/(app)/clients/[id]/intake/page.tsx", // self-reported intake estimate: governed by clin.view_intake
    "lib/search/navigation-registry.ts", // a search keyword, no data
    "lib/supabase/queries.ts", // the gate itself
    "lib/clients/profile-baseline.ts", // the edit form's compare baseline: changed fields only, and the action drops the key without the gate
  ]);
  it("lists every file naming skin_notes or fitzpatrick_type", () => {
    const hits = ["app", "lib", "components"]
      .flatMap((d) => walkFiles(d))
      .filter((f) => /skin_notes|fitzpatrick_type/.test(read(f)))
      .sort();
    expect(hits.filter((f) => !REVIEWED.has(f))).toEqual([]);
  });
});
