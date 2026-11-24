import { machineModelLabel, registrableProfiles } from "@/lib/machines/display-name";
import { xcellRegistrationAllowed } from "@/lib/machines/xcell-registration-gate";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { listStudioMachines, publishedModesFor, type MachineDb } from "@/lib/machines/machine-queries";
import { listableProfiles } from "@/lib/machines/listable-profiles";
import { activeProfiles } from "@/lib/machines/profile-contract";
import { OWNER_INPUT_REQUEST } from "@/lib/machines/owner-input-copy";
import { catalogueForRuntime } from "@/lib/machines/synthetic-profile";
import { registerMachineAction } from "../../clients/[id]/sessions/[sessionId]/machine-setup-actions";
import {
  MachineRegisterForm,
  type RegisterResult,
} from "@/components/machines/machine-register-form";
import { OwnerOnlyNotice } from "@/components/settings/view-heading";
import { StudioMachinesForm } from "@/components/machines/studio-machines-form";
import { readStudioMachineSettings, STUDIO_MACHINE_MODELS } from "@/lib/machines/studio-machine-settings";
import { setStudioMachineDefaultAction, setStudioMachineModelAction } from "./studio-machine-actions";
import { studioMachineRpc } from "@/lib/machines/studio-machine-rpc";
import { chartingRolloutFor } from "@/lib/rollouts/charting-rollout";

export default async function MachineSettingsPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();

  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only studio owners can register machines.</OwnerOnlyNotice>;
  }

  // Reviewed models whose field contract is PUBLISHED. `registerMachineAction`
  // re-checks both rules; the list only avoids offering a model that would
  // then refuse. A failed contract read lists nothing.
  const db = (await createClient()) as unknown as MachineDb;
  const catalogue = catalogueForRuntime();
  const active = activeProfiles(catalogue);
  const published = new Map<string, readonly string[] | null>();
  let checkFailed = false;
  for (const p of active) {
    const res = await publishedModesFor(db, p.profileId, p.version);
    if (!res.ok) checkFailed = true;
    published.set(`${p.profileId}@${p.version}`, res.ok ? res.value : null);
  }
  const listed = await listStudioMachines(db, studio.id);
  const models = registrableProfiles(
    listableProfiles(active, (p) => published.get(`${p.profileId}@${p.version}`) ?? null),
    listed.ok ? listed.value : [],
    await xcellRegistrationAllowed(studio.id),
  ).map((p) => ({
    profileId: p.profileId,
    label: machineModelLabel(p),
  }));

  // THE OWNER'S SWITCHES. Shown only while the platform rollout is on for this studio (the commands refuse otherwise), and only when the
  // read worked: a failed read says so rather than showing every machine as off.
  const switchesAvailable = await chartingRolloutFor(studio.id);
  const rpc = studioMachineRpc;
  const switches = switchesAvailable ? await readStudioMachineSettings(studio.id, rpc) : null;

  async function register(input: {
    profileId: string;
    displayName: string;
  }): Promise<RegisterResult> {
    "use server";
    // Only the two fields the action takes: this function is callable from the
    // browser, so nothing else a client sends is forwarded.
    const res = await registerMachineAction({
      profileId: input.profileId,
      displayName: input.displayName,
    });
    if (res.ok) revalidatePath("/settings/machines");
    return { ok: res.ok, error: res.ok ? undefined : res.error };
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 tabIndex={-1} data-settings-heading className="text-lg font-semibold outline-none">Machines</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Register the machines in your studio so they appear when you chart.{" "}
          {OWNER_INPUT_REQUEST}
        </p>
      </section>

      {switchesAvailable && (
        <section aria-labelledby="studio-machines-heading">
          <h3 id="studio-machines-heading" className="text-sm font-semibold">Studio machines</h3>
          <div className="mt-3">
            {switches ? (
              <StudioMachinesForm
                models={STUDIO_MACHINE_MODELS.map((m) => ({ profileId: m.profileId, name: m.name, description: m.description }))}
                initial={switches}
                setModel={setStudioMachineModelAction}
                setDefault={setStudioMachineDefaultAction}
              />
            ) : (
              <p className="text-sm text-red-700 dark:text-red-400" data-testid="studio-machines-unavailable">Your machine settings could not be loaded just now. Please reload the page.</p>
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="register-heading">
        <h3 id="register-heading" className="text-sm font-semibold">
          Register a machine
        </h3>
        <div className="mt-3">
          <MachineRegisterForm models={models} register={register} contractCheckFailed={checkFailed && models.length === 0} />
        </div>
      </section>

      <section aria-labelledby="registered-heading">
        <h3 id="registered-heading" className="text-sm font-semibold">
          Registered machines
        </h3>
        {!listed.ok ? (
          <p className="mt-2 text-sm text-red-700 dark:text-red-400">
            {listed.error}
          </p>
        ) : listed.value.length === 0 ? (
          <p
            className="mt-2 text-sm text-neutral-600 dark:text-neutral-400"
            data-testid="machine-registered-none"
          >
            No machines registered yet.
          </p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm" data-testid="machine-registered-list">
            {listed.value.map((m) => (
              <li key={m.deviceId}>{m.displayName}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
