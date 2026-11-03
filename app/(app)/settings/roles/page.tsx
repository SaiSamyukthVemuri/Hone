import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { OwnerOnlyNotice, SettingsViewHeading, STUDIO_WIDE_SCOPE } from "@/components/settings/view-heading";
import { dbErrorCode } from "@/lib/logging/error-class";
import { loadStudioPolicyState } from "@/lib/settings/roles/policy-store";
import { ROLE_LABELS } from "@/lib/settings/roles/model";
import type { Role } from "@/lib/permissions/catalog";
import { resetRolePolicyAction, saveRolePolicyAction } from "./actions";
import { RolesEditor } from "./roles-editor";

// Settings -> Roles (R2). Owner-only. The owner sees each role, who holds it, what the role may do, and changes it through the one
// permission catalog. Staff are added, removed and revoked in Team (the existing flow); this page links there rather than
// duplicating it. Receptionist accounts do not exist in the product yet, so that role lists nobody and says why.

// DN-21: this page reads ONLY the columns it shows. A practitioner row also carries a private calendar link and its checksum and an
// invitation row carries more than a name and an address; none of that is selected, so none of it can reach a render or a prop.
type StaffRow = { id: string; display_name: string; email: string };
type InviteRow = { id: string; display_name: string | null; email: string; role: string };

async function activeStaff(studioId: string): Promise<(StaffRow & { role: string })[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("practitioners")
    .select("id, display_name, email, role")
    .eq("studio_id", studioId)
    .eq("active", true)
    .order("display_name", { ascending: true });
  if (error) throw new Error(`Failed to load practitioners: ${dbErrorCode(error)}`);
  return (data ?? []) as (StaffRow & { role: string })[];
}

async function pendingInvitations(studioId: string): Promise<InviteRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pending_invitations")
    .select("id, display_name, email, role")
    .eq("studio_id", studioId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to load invitations: ${dbErrorCode(error)}`);
  return (data ?? []) as InviteRow[];
}

export default async function RolesSettingsPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only the studio owner can see and change roles and permissions.</OwnerOnlyNotice>;
  }

  const [practitioners, invitations, state] = await Promise.all([
    activeStaff(studio.id),
    pendingInvitations(studio.id),
    loadStudioPolicyState(studio.id),
  ]);

  const staffFor = (role: Role) => ({
    active: role === "practitioner" ? practitioners.filter((p) => p.role === "practitioner") : [],
    pending: invitations.filter((i) => i.role === role),
  });

  return (
    <div className="flex flex-col gap-8">
      <SettingsViewHeading title="Roles" scope={STUDIO_WIDE_SCOPE}>
        Choose what practitioners and receptionists can do in this studio. You always have every permission.
      </SettingsViewHeading>
      <RolesEditor
        policies={{ practitioner: state.policy, receptionist: state.policy }}
        reviewed={state.reviewed}
        version={state.version}
        writable={state.writable}
        notWritableReason={state.notWritableReason}
        staff={{
          practitioner: <StaffPanel role="practitioner" {...staffFor("practitioner")} />,
          receptionist: <StaffPanel role="receptionist" {...staffFor("receptionist")} />,
        }}
        save={saveRolePolicyAction}
        reset={resetRolePolicyAction}
      />
    </div>
  );
}

function StaffPanel({ role, active, pending }: { role: Role; active: StaffRow[]; pending: InviteRow[] }) {
  const label = ROLE_LABELS[role].toLowerCase();
  return (
    <section data-testid={`roles-staff-${role}`} className="flex min-w-0 flex-col gap-4">
      <div>
        <h3 className="text-base font-medium">{ROLE_LABELS[role]}s in your studio</h3>
        <p className="mt-1 text-sm text-neutral-500">
          Add, remove or invite people in{" "}
          <Link href="/settings/team" className="font-medium text-neutral-900 underline underline-offset-2 dark:text-neutral-100">
            Team
          </Link>
          .
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">Active</h4>
        {role === "receptionist" ? (
          <p className="text-sm text-neutral-500">No receptionists yet. Receptionist accounts arrive with the front desk.</p>
        ) : active.length === 0 ? (
          <p className="text-sm text-neutral-500">No {label}s yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {active.map((p) => (
              <li key={p.id} className="min-w-0 px-4 py-3">
                <div className="break-words font-medium">{p.display_name}</div>
                <div className="break-all text-xs text-neutral-500">{p.email}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">Invited, not joined yet</h4>
        {pending.length === 0 ? (
          <p className="text-sm text-neutral-500">Nobody is waiting to join as a {label}.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {pending.map((i) => (
              <li key={i.id} className="min-w-0 px-4 py-3">
                <div className="break-words font-medium">{i.display_name ?? "No name set"}</div>
                <div className="break-all text-xs text-neutral-500">{i.email}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
