import { createClient } from "@/lib/supabase/server";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { OwnerOnlyNotice, SettingsViewHeading, STUDIO_WIDE_SCOPE } from "@/components/settings/view-heading";
import { dbErrorCode } from "@/lib/logging/error-class";
import { loadStudioPolicyState } from "@/lib/settings/roles/policy-store";
import type { Role } from "@/lib/permissions/catalog";
import { resetRolePolicyAction, saveRolePolicyAction } from "./actions";
import { RolesEditor, type PersonView } from "./roles-editor";

// Settings -> Roles (R2). Owner-only. The owner sees each role, who holds it, what the role may do, and changes it through the one
// permission catalog. Staff are added, removed and revoked in Team (the existing flow); this page links there rather than
// duplicating it. Receptionist accounts do not exist in the product yet, so that role lists nobody and says why.

// DN-21: this page reads ONLY the columns it shows. A practitioner row also carries a private calendar link and its checksum and an
// invitation row carries more than a name and an address; none of that is selected, so none of it can reach a render or a prop.
type StaffRow = { id: string; display_name: string; email: string; role: string; active: boolean };
type InviteRow = { id: string; display_name: string | null; email: string; role: string };

async function allStaff(studioId: string): Promise<StaffRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("practitioners")
    .select("id, display_name, email, role, active")
    .eq("studio_id", studioId)
    .order("display_name", { ascending: true });
  if (error) throw new Error(`Failed to load practitioners: ${dbErrorCode(error)}`);
  return (data ?? []) as StaffRow[];
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

const asRole = (r: string): "owner" | Role => (r === "owner" ? "owner" : r === "receptionist" ? "receptionist" : "practitioner");

export default async function RolesSettingsPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only the studio owner can see and change roles and permissions.</OwnerOnlyNotice>;
  }

  const [staff, invitations, state] = await Promise.all([
    allStaff(studio.id),
    pendingInvitations(studio.id),
    loadStudioPolicyState(studio.id),
  ]);

  // Real members only. An invitation has no access, and a deactivated person has none either; the People view says so.
  const people: PersonView[] = [
    ...staff.map((p): PersonView => ({ id: p.id, name: p.display_name, email: p.email, role: asRole(p.role), state: p.active ? "active" : "deactivated" })),
    ...invitations.map((i): PersonView => ({ id: i.id, name: i.display_name ?? "No name set", email: i.email, role: asRole(i.role), state: "invited" })),
  ];

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
        people={people}
        save={saveRolePolicyAction}
        reset={resetRolePolicyAction}
      />
    </div>
  );
}
