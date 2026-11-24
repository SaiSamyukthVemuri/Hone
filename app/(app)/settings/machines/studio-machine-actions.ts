"use server";

import { revalidatePath } from "next/cache";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { readStudioMachineSettings, setStudioMachineDefault, setStudioMachineModel } from "@/lib/machines/studio-machine-settings";
import { studioMachineRpc } from "@/lib/machines/studio-machine-rpc";
import type { StudioMachinesResult, StudioMachinesState } from "@/components/machines/studio-machines-form";

// MODULE-SCOPE SERVER ACTIONS. They used to be defined inline in the page and closed over render-local functions, which cannot be serialized into a
// server action, so the page failed to render with the rollout on. Nothing is captured here: the studio and the owner are derived from the SIGNED-IN
// session on every call, and only the two values being changed are accepted from the browser. The database re-checks an active owner of that studio.
const NOT_OWNER = "Only studio owners can change machines.";

async function afterWrite(studioId: string, write: { ok: true } | { ok: false; error: string }): Promise<StudioMachinesResult> {
  if (!write.ok) return write;
  const fresh = await readStudioMachineSettings(studioId, studioMachineRpc);
  if (!fresh) return { ok: false, error: "Your machine settings were saved but could not be reloaded. Please refresh the page." };
  revalidatePath("/settings/machines");
  return { ok: true, state: fresh as StudioMachinesState };
}

export async function setStudioMachineModelAction(profileId: string, enabled: boolean): Promise<StudioMachinesResult> {
  const who = await requirePractitionerWithStudio();
  if (who.practitioner.role !== "owner") return { ok: false, error: NOT_OWNER };
  return afterWrite(who.studio.id, await setStudioMachineModel(who.studio.id, profileId, enabled, studioMachineRpc));
}

export async function setStudioMachineDefaultAction(profileId: string | null): Promise<StudioMachinesResult> {
  const who = await requirePractitionerWithStudio();
  if (who.practitioner.role !== "owner") return { ok: false, error: NOT_OWNER };
  return afterWrite(who.studio.id, await setStudioMachineDefault(who.studio.id, profileId, studioMachineRpc));
}
