import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getIntakeById, getLatestIntakeForClient } from "@/lib/intake/queries";
import { PRACTITIONER_ENTERABLE_STEPS } from "@/lib/intake/questions";
import { AssistedIntakeEditor } from "./AssistedIntakeEditor";

// "Complete intake with client", the practitioner-assisted questionnaire
// editor.
//
// Scope: the health questionnaire only (every step except the client's own
// acknowledgements). The acknowledgements and the submission itself stay with
// the client, on their own link, through the existing public route.
//
// This page resolves and authorises; the editor is a pure client component
// that talks to saveAssistedIntakeStepAction / handOffAssistedIntakeAction,
// both of which re-derive the studio and practitioner from the session and
// re-apply every predicate in their own UPDATE. Nothing here is a substitute
// for that.
export default async function AssistedIntakePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ intake?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const requestedIntakeId =
    typeof sp.intake === "string" && sp.intake ? sp.intake : null;

  const { studio } = await getCurrentPractitionerWithStudio();

  const supabase = await createClient();
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id, name")
    .eq("studio_id", studio.id)
    .eq("id", id)
    .maybeSingle();
  // A cross-studio or absent client is a 404, identical to the review page,
  // it does not disclose that the row exists somewhere else.
  if (clientErr) notFound();
  if (!client) notFound();

  // Resolve the intake: an explicit ?intake=<id> when the practitioner came
  // from a specific history row, otherwise this client's latest. A requested
  // id belonging to another client falls through to null rather than being
  // honoured.
  let intake = null;
  if (requestedIntakeId) {
    const looked = await getIntakeById(studio.id, requestedIntakeId);
    if (looked && looked.client_id === id) intake = looked;
  } else {
    intake = await getLatestIntakeForClient(studio.id, id);
  }

  // Assisted entry only ever applies to an intake still being filled in.
  // A submitted or reviewed intake is terminal: the correction model is a
  // NEW intake (Request intake update), never a rewrite of history.
  if (!intake || intake.status !== "in_progress") {
    redirect(`/clients/${id}/intake`);
  }

  const responses = (intake.responses ?? {}) as Record<string, unknown>;
  const firstStepId = PRACTITIONER_ENTERABLE_STEPS[0]?.id ?? 1;
  const lastEnterableId =
    PRACTITIONER_ENTERABLE_STEPS[PRACTITIONER_ENTERABLE_STEPS.length - 1]?.id ??
    firstStepId;
  // Resume where the intake left off, clamped into the practitioner-enterable
  // range. A client who already reached the acknowledgements step leaves
  // current_step at the last step; the practitioner still opens on the last
  // step they may edit.
  const initialStep = Math.min(
    Math.max(Number(intake.current_step) || firstStepId, firstStepId),
    lastEnterableId,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={`/clients/${id}/intake`}
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← Health intake
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">
          Complete intake with {client.name}
        </h1>
      </div>

      <AssistedIntakeEditor
        clientId={id}
        clientName={client.name}
        intakeId={intake.id}
        initialStep={initialStep}
        initialResponses={responses}
        initialUpdatedAt={intake.updated_at}
      />
    </div>
  );
}
