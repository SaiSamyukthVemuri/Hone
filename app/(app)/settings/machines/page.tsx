import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { listStudioMachines, type MachineDb } from "@/lib/machines/machine-queries";
import { activeProfiles } from "@/lib/machines/profile-contract";
import { OWNER_INPUT_REQUEST } from "@/lib/machines/owner-input-copy";
import { catalogueForRuntime } from "@/lib/machines/synthetic-profile";
import { registerMachineAction } from "../../clients/[id]/sessions/[sessionId]/machine-setup-actions";
import {
  MachineRegisterForm,
  type RegisterResult,
} from "@/components/machines/machine-register-form";

export default async function MachineSettingsPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();

  if (practitioner.role !== "owner") {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        Only studio owners can register machines.
      </div>
    );
  }

  // Reviewed models only. `registerMachineAction` re-checks the same rule and
  // also refuses a model whose field contract is not published, so this list
  // is a convenience, never the gate.
  const catalogue = catalogueForRuntime();
  const models = activeProfiles(catalogue).map((p) => ({
    profileId: p.profileId,
    label: `${p.manufacturer} ${p.model}`,
  }));

  const db = (await createClient()) as unknown as MachineDb;
  const listed = await listStudioMachines(db, studio.id);

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
        <h2 className="text-lg font-semibold">Machines</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Register the machines in your studio so they appear when you chart.{" "}
          {OWNER_INPUT_REQUEST}
        </p>
      </section>

      <section aria-labelledby="register-heading">
        <h3 id="register-heading" className="text-sm font-semibold">
          Register a machine
        </h3>
        <div className="mt-3">
          <MachineRegisterForm models={models} register={register} />
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
