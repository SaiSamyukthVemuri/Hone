import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { expectedCsvFiles, exportedResources } from "@/lib/export/resource-registry";

type AuditResult = { error: null | { code: "audit_write_unavailable" } };
const refused = (): AuditResult => ({ error: { code: "audit_write_unavailable" } });

// The request resolver intentionally caches membership. Privileged emission
// must independently verify the current session and exact active membership.
async function freshAuditMembership(
  client: Awaited<ReturnType<typeof createClient>>,
  practitionerId: string,
  studioId: string,
): Promise<{ role: string; userId: string } | null> {
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) return null;
  const { data: member, error } = await client.from("practitioners")
    .select("id,user_id,studio_id,active,role")
    .eq("id", practitionerId).eq("user_id", user.id)
    .eq("studio_id", studioId).eq("active", true).maybeSingle();
  if (error || !member || member.id !== practitionerId || member.user_id !== user.id
    || member.studio_id !== studioId || member.active !== true || typeof member.role !== "string") return null;
  return { role: member.role, userId: user.id };
}

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
    const membership = await freshAuditMembership(client, practitioner.id, studio.id);
    if (!membership) return refused();

    const admin = createAdminClient();
    // The early session read is only a refusal optimization. This command
    // locks/rechecks membership and inserts the fixed audit row atomically.
    const { data: recorded, error: writeError } = await admin.rpc("record_client_archive_audit_governed", {
      p_actor_id: practitioner.id, p_user_id: membership.userId,
      p_studio_id: studio.id, p_client_id: data.id,
      p_archived: input.change === "archive",
      p_archived_at: input.change === "archive" ? input.archivedAt! : null,
    });
    // Missing/skewed RPC, refused membership and malformed success all fail
    // closed. Never fall back to service/user direct table INSERT.
    return writeError || recorded !== true ? refused() : { error: null };
  } catch {
    // Archive/unarchive already committed before this best-effort emission.
    // A thrown lookup/transport failure must not falsely report rollback or
    // prevent the caller's safe diagnostic, revalidation and redirect.
    return refused();
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
    const client = await createClient();
    const membership = await freshAuditMembership(client, practitioner.id, studio.id);
    if (!membership || membership.role !== "owner") return refused();
    const admin = createAdminClient();
    const { data: recorded, error } = await admin.rpc("record_studio_export_audit_governed", {
      p_actor_id: practitioner.id, p_user_id: membership.userId, p_studio_id: studio.id,
      p_filename: input.filename, p_files: [...input.files], p_row_counts: { ...input.rowCounts },
    });
    // Atomic authorization/audit is a release prerequisite, not an optional
    // enhancement. A missing/refused command withholds the archive.
    return error || recorded !== true ? refused() : { error: null };
  } catch {
    return refused();
  }
}
