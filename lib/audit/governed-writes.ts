import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { expectedCsvFiles, exportedResources } from "@/lib/export/resource-registry";

type AuditResult = { error: null | { code: "audit_write_unavailable" } };
const refused = (): AuditResult => ({ error: { code: "audit_write_unavailable" } });

// These are internal server helpers, NOT exported Server Actions. There is no
// helper transport accepting a raw actor/studio/action/entity-type/metadata object.
export async function recordClientArchiveAudit(input: {
  expectedStudioId: string;
  clientId: string;
  change: "archive" | "unarchive";
  archivedAt?: string;
}): Promise<AuditResult> {
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (!practitioner.active || studio.id !== input.expectedStudioId) return refused();
    if (input.change !== "archive" && input.change !== "unarchive") return refused();
    if (input.change === "archive") {
      if (typeof input.archivedAt !== "string") return refused();
      const timestamp = new Date(input.archivedAt);
      if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== input.archivedAt) return refused();
    }
    const client = await createClient();
    const { data, error } = await client.from("clients").select("id")
      .eq("id", input.clientId).eq("studio_id", studio.id).maybeSingle();
    if (error || !data || data.id !== input.clientId) return refused();

    const { error: writeError } = await createAdminClient().from("audit_logs").insert({
      studio_id: studio.id, actor_id: practitioner.id,
      action: input.change === "archive" ? "client_archived" : "client_unarchived",
      entity_type: "client", entity_id: data.id,
      metadata: input.change === "archive" ? { archived_at: input.archivedAt } : {},
    });
    return writeError ? refused() : { error: null };
  } catch {
    // Preserve the existing action rejection on a rejected audit promise.
    // Returned audit errors stay best-effort; raw database text never escapes.
    throw new Error("Could not record the archive audit entry. Please try again.");
  }
}

export async function recordStudioExportAudit(input: {
  expectedStudioId: string;
  filename: string;
  files: ReadonlyArray<string>;
  rowCounts: Readonly<Record<string, number>>;
}): Promise<AuditResult> {
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (!practitioner.active || practitioner.role !== "owner" || studio.id !== input.expectedStudioId) return refused();
    const slug = studio.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "studio";
    const prefix = `hone-export-${slug}-`;
    if (!input.filename.startsWith(prefix) || !/^\d{4}-\d{2}-\d{2}\.zip$/.test(input.filename.slice(prefix.length))) return refused();
    const approvedFiles = new Set([...expectedCsvFiles(), "manifest.json", "README.txt"]);
    if (new Set(input.files).size !== input.files.length || !input.files.includes("manifest.json")
      || !input.files.includes("README.txt") || input.files.some((file) => !approvedFiles.has(file))) return refused();
    const resources: string[] = exportedResources().filter(({ disposition }) => input.files.includes(disposition.file)).map(({ resource }) => resource);
    const keys = Object.keys(input.rowCounts);
    if (keys.length !== resources.length || keys.some((key) => !resources.includes(key))
      || Object.values(input.rowCounts).some((count) => !Number.isSafeInteger(count) || count < 0)) return refused();
    const { error } = await createAdminClient().from("audit_logs").insert({
      studio_id: studio.id, actor_id: practitioner.id, action: "studio_export",
      entity_type: "studio", entity_id: studio.id,
      metadata: { filename: input.filename, files: [...input.files], row_counts: { ...input.rowCounts } },
    });
    return error ? refused() : { error: null };
  } catch {
    return refused();
  }
}
