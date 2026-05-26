"use client";

import { useState, useTransition } from "react";
import type { TreatmentPlanWithStages } from "@/lib/treatment-plans/queries";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  TreatmentScheduleEditor,
  type TreatmentScheduleAction,
} from "@/components/treatment-schedule-editor";

type ActionFn = (formData: FormData) => Promise<
  { ok: true } | { ok: false; error: string }
>;

type Props = {
  clientId: string;
  plans: TreatmentPlanWithStages[];
  createAction: ActionFn;
  closeAction: ActionFn;
  // Phase C additions — all are narrow authenticated actions that go
  // through the same RLS-scoped Supabase client as the existing
  // create/close actions. The plan card passes them down to the
  // <TreatmentScheduleEditor> and the per-plan notes editor.
  updateNotesAction: ActionFn;
  createStageAction: TreatmentScheduleAction;
  updateStageAction: TreatmentScheduleAction;
  deleteStageAction: TreatmentScheduleAction;
  practitionerNames: Record<string, string>;
};

const MAX_NAME = 100;
const MAX_VISITS = 200;

export function TreatmentPlansCard({
  clientId,
  plans,
  createAction,
  closeAction,
  updateNotesAction,
  createStageAction,
  updateStageAction,
  deleteStageAction,
  practitionerNames,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [visits, setVisits] = useState("12");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const active = plans.filter((p) => p.status === "active");
  const closed = plans.filter((p) => p.status === "closed");

  function submitCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Plan name is required.");
      return;
    }
    if (trimmedName.length > MAX_NAME) {
      setError(`Plan name must be ${MAX_NAME} characters or fewer.`);
      return;
    }
    const visitsNum = parseInt(visits, 10);
    if (!Number.isFinite(visitsNum) || visitsNum < 1 || visitsNum > MAX_VISITS) {
      setError(`Estimated visits must be between 1 and ${MAX_VISITS}.`);
      return;
    }
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("name", trimmedName);
    fd.set("suggested_visit_count", String(visitsNum));
    setError(null);
    startTransition(async () => {
      const res = await createAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setName("");
      setVisits("12");
      setAdding(false);
    });
  }

  function submitClose(planId: string) {
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("plan_id", planId);
    setError(null);
    startTransition(async () => {
      const res = await closeAction(fd);
      if (!res.ok) setError(res.error);
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
        Treatment plans
      </h2>

      {/* Informational callout: signals that the current plan model is a
          simple target and that treatment schedules (stages + how often +
          visit length + budget notes) are the next iteration. Calm
          neutral palette so it does not read as a warning. UI/copy only
          — no field or behavior change. */}
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-xs dark:border-neutral-800 dark:bg-neutral-900">
        <p className="font-medium text-neutral-800 dark:text-neutral-200">
          Treatment schedules are coming
        </p>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">
          Soon you&rsquo;ll be able to plan stages like weekly 15-minute
          visits for 3 months, then monthly maintenance visits. For now,
          just enter a rough estimate.
        </p>
      </div>

      {plans.length === 0 && !adding && (
        <p className="text-sm text-neutral-500">
          Track multi-session treatments with a plan. Helpful for arm or leg
          work over 12+ sessions.
        </p>
      )}

      {active.length > 0 && (
        <div className="flex flex-col gap-3">
          {active.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              clientId={clientId}
              practitionerNames={practitionerNames}
              pending={pending}
              onClose={() => submitClose(p.id)}
              updateNotesAction={updateNotesAction}
              createStageAction={createStageAction}
              updateStageAction={updateStageAction}
              deleteStageAction={deleteStageAction}
            />
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">
            Closed
          </p>
          <div className="flex flex-col gap-3">
            {closed.map((p) => (
              <PlanCard
                key={p.id}
                plan={p}
                clientId={clientId}
                practitionerNames={practitionerNames}
                pending={pending}
                onClose={null}
                updateNotesAction={updateNotesAction}
                createStageAction={createStageAction}
                updateStageAction={updateStageAction}
                deleteStageAction={deleteStageAction}
              />
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {adding ? (
        <div className="flex flex-col gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900">
          <p className="text-sm font-medium">Create treatment plan</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Plan name
            </span>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_NAME}
              placeholder="e.g. Lower legs electrolysis"
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label className="flex flex-col gap-1.5 max-w-[12rem]">
            <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Estimated visits
            </span>
            {/* FormData field name (`suggested_visit_count`) is unchanged —
                only the visible label is renamed. The server action and
                schema column are untouched. */}
            <input
              type="number"
              min={1}
              max={MAX_VISITS}
              step={1}
              value={visits}
              onChange={(e) => setVisits(e.target.value)}
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <p className="-mt-1 text-[11px] text-neutral-500">
            A rough estimate for now. Treatment schedules with how often,
            visit length, and budget notes are coming next.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submitCreate}
              disabled={pending}
              className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              Create plan
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setName("");
                setVisits("12");
                setError(null);
              }}
              disabled={pending}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="self-start rounded-md border border-dashed border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          + New plan
        </button>
      )}
    </section>
  );
}

function PlanCard({
  plan,
  clientId,
  practitionerNames,
  pending,
  onClose,
  updateNotesAction,
  createStageAction,
  updateStageAction,
  deleteStageAction,
}: {
  plan: TreatmentPlanWithStages;
  clientId: string;
  practitionerNames: Record<string, string>;
  pending: boolean;
  onClose: (() => void) | null;
  updateNotesAction: ActionFn;
  createStageAction: TreatmentScheduleAction;
  updateStageAction: TreatmentScheduleAction;
  deleteStageAction: TreatmentScheduleAction;
}) {
  const isClosed = plan.status === "closed";
  const isComplete = plan.attached_count >= plan.suggested_visit_count;
  const percent = Math.min(
    100,
    Math.round((plan.attached_count / plan.suggested_visit_count) * 100),
  );
  const createdBy = plan.created_by_practitioner_id
    ? practitionerNames[plan.created_by_practitioner_id]
    : null;
  const closedBy = plan.closed_by_practitioner_id
    ? practitionerNames[plan.closed_by_practitioner_id]
    : null;

  return (
    <div
      className={`flex flex-col gap-3 rounded-md border p-4 ${
        isClosed
          ? "border-neutral-200 bg-neutral-50 opacity-75 dark:border-neutral-800 dark:bg-neutral-900"
          : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {plan.name}
        </p>
        {isClosed ? (
          <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            Closed
          </span>
        ) : (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            Active
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 text-xs text-neutral-500">
        <span>
          Created <FormattedDateTime iso={plan.created_at} />
          {createdBy ? ` by ${createdBy}` : ""}
        </span>
        {isClosed && plan.closed_at && (
          <span>
            Closed <FormattedDateTime iso={plan.closed_at} />
            {closedBy ? ` by ${closedBy}` : ""}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="tabular-nums">
            {plan.attached_count} of {plan.suggested_visit_count} visits
          </span>
          {isClosed && isComplete && (
            <span className="text-xs text-emerald-700 dark:text-emerald-400">
              Complete
            </span>
          )}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
          <div
            className="h-full bg-amber-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {/* Phase C: treatment schedule (stages) + practitioner-only notes.
          The schedule editor renders for both active and closed plans —
          closed plans show stages read-only. The notes editor only
          renders for active plans (closed plans show read-only notes
          if any). Both surfaces sit BELOW the legacy attached-visits
          progress and ABOVE the Close plan button so the visual
          hierarchy still leads with "what's this plan doing today". */}
      <TreatmentScheduleEditor
        planId={plan.id}
        clientId={clientId}
        isClosed={isClosed}
        stages={plan.stages}
        createStageAction={createStageAction}
        updateStageAction={updateStageAction}
        deleteStageAction={deleteStageAction}
      />

      <PlanNotesEditor
        plan={plan}
        clientId={clientId}
        isClosed={isClosed}
        action={updateNotesAction}
      />

      {onClose && !isClosed && (
        <div className="flex flex-col gap-2 pt-1">
          {isComplete && (
            <p className="text-xs italic text-neutral-600 dark:text-neutral-400">
              All suggested visits complete.
            </p>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className={
              isComplete
                ? "self-start rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
                : "self-start rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
            }
          >
            Close plan
          </button>
        </div>
      )}
    </div>
  );
}

// Phase C: practitioner-only budget + clinical notes for a treatment plan.
// Both fields are nullable text columns on treatment_plans (migration
// 0034). Closed plans render the notes read-only (or omit if empty).
// Active plans show an Edit toggle that opens a compact textarea form.
//
// These notes are NOT shown to clients and NOT included in any email.
function PlanNotesEditor({
  plan,
  clientId,
  isClosed,
  action,
}: {
  plan: TreatmentPlanWithStages;
  clientId: string;
  isClosed: boolean;
  action: ActionFn;
}) {
  const [editing, setEditing] = useState(false);
  const [budget, setBudget] = useState(plan.budget_notes ?? "");
  const [practitioner, setPractitioner] = useState(
    plan.practitioner_notes ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const hasNotes =
    (plan.budget_notes && plan.budget_notes.length > 0) ||
    (plan.practitioner_notes && plan.practitioner_notes.length > 0);

  // Closed plans: don't show the editor at all if there are no notes,
  // and render read-only if there are.
  if (isClosed && !hasNotes) return null;

  function submit() {
    setError(null);
    const fd = new FormData();
    fd.set("plan_id", plan.id);
    fd.set("client_id", clientId);
    fd.set("budget_notes", budget);
    fd.set("practitioner_notes", practitioner);
    // Always re-send the existing override unchanged. The override
    // field is not edited from this form in Phase C; Phase D will wire
    // it to a derived computation. Preserve whatever is currently on
    // the plan so a save here doesn't accidentally clear it.
    if (plan.treatment_goal_minutes_override != null) {
      fd.set(
        "treatment_goal_minutes_override",
        String(plan.treatment_goal_minutes_override),
      );
    }
    startTransition(async () => {
      const r = await action(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setEditing(false);
    });
  }

  function cancel() {
    setBudget(plan.budget_notes ?? "");
    setPractitioner(plan.practitioner_notes ?? "");
    setError(null);
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="flex flex-col gap-1.5 border-t border-neutral-200 pt-3 dark:border-neutral-800">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Notes
          </p>
          {!isClosed && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-[11px] text-neutral-500 hover:underline"
            >
              {hasNotes ? "Edit" : "Add notes"}
            </button>
          )}
        </div>
        {hasNotes ? (
          <div className="flex flex-col gap-2 text-xs">
            {plan.budget_notes && (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-neutral-500">
                  Budget notes
                </p>
                <p className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
                  {plan.budget_notes}
                </p>
              </div>
            )}
            {plan.practitioner_notes && (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-neutral-500">
                  Practitioner notes
                </p>
                <p className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
                  {plan.practitioner_notes}
                </p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-neutral-500">
            No notes yet. These stay on the practitioner side.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-300 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900">
      <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
        Edit plan notes
      </p>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Budget notes
        </span>
        <textarea
          rows={2}
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="e.g. if weekly is unaffordable, move to every 2 weeks; timeline ~3 months longer."
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <span className="text-[11px] text-neutral-500">
          Notes about what to adjust if the client needs a lower-cost
          schedule.
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Practitioner notes
        </span>
        <textarea
          rows={3}
          value={practitioner}
          onChange={(e) => setPractitioner(e.target.value)}
          placeholder="e.g. dense terminal hair on chin, expect plateau around month 4."
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <span className="text-[11px] text-neutral-500">
          Clinical reasoning or context for this plan.
        </span>
      </label>

      {error && (
        <p className="text-xs text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {pending ? "Saving…" : "Save notes"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
