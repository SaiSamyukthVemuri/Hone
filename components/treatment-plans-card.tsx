"use client";

import { useState, useTransition } from "react";
import type { TreatmentPlanWithStages } from "@/lib/treatment-plans/queries";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  TreatmentScheduleEditor,
  type TreatmentScheduleAction,
} from "@/components/treatment-schedule-editor";
import { computePlannedVsActual } from "@/lib/treatment-time/plans";
import { formatMinutes } from "@/lib/treatment-time/format";
import { MultiAreaPicker } from "@/components/multi-area-picker";
import {
  formatTimelineMonths,
  resolveTreatmentAreas,
} from "@/lib/treatment-plans/display";

const PRIMARY_AREA_MAX = 60;
const MAX_NAME = 100;

// Auto-name (PR #128, Part 4). The previous shape ("Chin and others
// treatment plan" for two areas) confused practitioners who could see
// both selected areas on screen but a vague label. Rebuild the auto-
// name as a " + "-joined area list and fall back to a counted suffix
// only when the full list would exceed MAX_NAME (which is the same
// budget the server enforces on save):
//   0 areas  -> ""
//   1 area   -> "Chin treatment plan"
//   2 areas  -> "Chin + Neck treatment plan"
//   3 areas  -> "Chin + Neck + Upper lip treatment plan"
//                  (or "Chin + Neck + 1 more treatment plan" if too long)
//   N areas  -> "Chin + Neck + (N-2) more treatment plan" when full
//               list overflows MAX_NAME, else full list.
// Treats the input order verbatim; the MultiAreaPicker preserves the
// selection order the practitioner clicked, so the first one or two
// chips stay visible in both the picker and the auto-name.
function buildAutoPlanName(areas: string[]): string {
  if (areas.length === 0) return "";
  if (areas.length === 1) return `${areas[0]} treatment plan`;
  const allJoined = `${areas.join(" + ")} treatment plan`;
  if (allJoined.length <= MAX_NAME) return allJoined;
  const tailCount = areas.length - 2;
  return `${areas[0]} + ${areas[1]} + ${tailCount} more treatment plan`;
}

type ActionFn = (formData: FormData) => Promise<
  { ok: true } | { ok: false; error: string }
>;

type Props = {
  clientId: string;
  plans: TreatmentPlanWithStages[];
  createAction: ActionFn;
  closeAction: ActionFn;
  // All narrow authenticated actions that go through the same
  // RLS-scoped Supabase client as the existing create/close actions.
  // The plan card passes them down to the <TreatmentScheduleEditor>
  // and the per-plan notes editor.
  updateNotesAction: ActionFn;
  createStageAction: TreatmentScheduleAction;
  updateStageAction: TreatmentScheduleAction;
  deleteStageAction: TreatmentScheduleAction;
  practitionerNames: Record<string, string>;
};

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
  // Tracks whether the practitioner has manually edited the plan name.
  // While false, the name auto-fills from the first selected area
  // ("Chin treatment plan" / "Chin + Jawline treatment plan"). Once the
  // practitioner types in the name field we stop overwriting it. Purely
  // client-side; the FormData `name` field and the server action are
  // unchanged.
  const [nameTouched, setNameTouched] = useState(false);
  const [areas, setAreas] = useState<string[]>([]);
  const [timelineMin, setTimelineMin] = useState("");
  const [timelineMax, setTimelineMax] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Area-first: changing the areas list auto-generates the plan name
  // until the practitioner edits the name themselves. Auto-name shape
  // is owned by buildAutoPlanName (PR #128, Part 4): the vague
  // "<first> and others treatment plan" became a " + "-joined list
  // ("Chin + Neck treatment plan") that falls back to "Chin + Neck +
  // <count> more treatment plan" only when the full list overflows
  // MAX_NAME. The nameTouched gate is unchanged so a typed name is
  // never overwritten and existing plans loaded from the DB are not
  // re-auto-named.
  function handleAreasChange(next: string[]) {
    setAreas(next);
    if (!nameTouched) {
      setName(buildAutoPlanName(next));
    }
  }

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
    for (const a of areas) {
      if (a.length > PRIMARY_AREA_MAX) {
        setError(
          `Each treatment area must be ${PRIMARY_AREA_MAX} characters or fewer.`,
        );
        return;
      }
    }
    const trimMin = timelineMin.trim();
    const trimMax = timelineMax.trim();
    if (trimMin && trimMax) {
      const a = parseInt(trimMin, 10);
      const b = parseInt(trimMax, 10);
      if (Number.isFinite(a) && Number.isFinite(b) && a > b) {
        setError("Timeline from-months must be less than or equal to to-months.");
        return;
      }
    }

    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("name", trimmedName);
    // Always send treatment_areas (possibly zero entries) so the server
    // action takes the multi-area path. Each selected area is its own
    // form value; the action's FormData.getAll("treatment_areas") will
    // pick them up.
    for (const a of areas) {
      fd.append("treatment_areas", a);
    }
    if (areas.length === 0) {
      // FormData.append above did nothing; send an explicit empty
      // marker so the action knows the field was present (clear) vs.
      // absent (untouched). Empty strings are filtered out by the
      // parser, leaving an empty array which the action normalises
      // to NULL on both treatment_areas and primary_area.
      fd.append("treatment_areas", "");
    }
    if (trimMin) fd.set("estimated_timeline_months_min", trimMin);
    if (trimMax) fd.set("estimated_timeline_months_max", trimMax);

    setError(null);
    startTransition(async () => {
      const res = await createAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setName("");
      setNameTouched(false);
      setAreas([]);
      setTimelineMin("");
      setTimelineMax("");
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

      {plans.length === 0 && !adding && (
        <p className="text-sm text-neutral-500">
          Track multi-session treatments with a plan. Electrolysis plans
          often run over months and depend on session length, consistency,
          area, hormones, density, and tolerance.
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

          {/* Area-first: a treatment plan can cover one or more areas.
              Picking areas auto-names the plan; the practitioner can
              edit the name. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
              Treatment areas
            </span>
            <MultiAreaPicker
              selected={areas}
              onChange={handleAreasChange}
              idPrefix="plan-create"
            />
            <span className="text-[11px] text-neutral-500">
              Pick the areas this plan covers (e.g. Chin and Jawline).
              You can leave this blank.
            </span>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">
              Plan name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              maxLength={MAX_NAME}
              placeholder="e.g. Chin treatment plan"
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <span className="text-[11px] text-neutral-500">
              Auto-filled from the areas. Edit it if you like.
            </span>
          </label>

          {/* Timeline reframing: months window, not visit count. The two
              inputs are optional; either side alone is fine ("about 24
              months", "at least 18 months"). The copy stays cautious;
              estimates change as treatment progresses. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">
              Estimated treatment timeline
            </span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={60}
                step={1}
                value={timelineMin}
                onChange={(e) => setTimelineMin(e.target.value)}
                placeholder="18"
                aria-label="Timeline minimum months"
                className="w-20 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
              <span className="text-sm text-neutral-600">to</span>
              <input
                type="number"
                min={1}
                max={60}
                step={1}
                value={timelineMax}
                onChange={(e) => setTimelineMax(e.target.value)}
                placeholder="24"
                aria-label="Timeline maximum months"
                className="w-20 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
              <span className="text-sm text-neutral-600">months</span>
            </div>
            <span className="text-[11px] text-neutral-500">
              Most electrolysis plans are discussed over months, not a
              fixed number of visits. Many clients need 18 to 24 months
              depending on area, density, hormones, consistency, session
              length, and skin tolerance. Both fields are optional.
            </span>
          </div>

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
                setNameTouched(false);
                setAreas([]);
                setTimelineMin("");
                setTimelineMax("");
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
  const createdBy = plan.created_by_practitioner_id
    ? practitionerNames[plan.created_by_practitioner_id]
    : null;
  const closedBy = plan.closed_by_practitioner_id
    ? practitionerNames[plan.closed_by_practitioner_id]
    : null;

  // Editing state lifted from PlanNotesEditor (PR #128, Part 3) so the
  // card header can expose a prominent "Edit plan" button next to the
  // status badge. The editor below renders the same form when this
  // flag is true; the header button and the existing in-notes Edit
  // link both write to it, so a returning practitioner has two
  // discoverable entry points to the plan-level editor.
  const [editing, setEditing] = useState(false);

  // Resolve the area chips: prefer the multi-area list, fall back to
  // the legacy primary_area so plans created before migration 0051
  // still render correctly.
  const areaChips = resolveTreatmentAreas(plan);
  const timelineLabel = formatTimelineMonths(
    plan.estimated_timeline_months_min,
    plan.estimated_timeline_months_max,
  );

  return (
    <div
      className={`flex flex-col gap-3 rounded-md border p-4 ${
        isClosed
          ? "border-neutral-200 bg-neutral-50 opacity-75 dark:border-neutral-800 dark:bg-neutral-900"
          : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {plan.name}
          </p>
          {areaChips.map((area) => (
            <span
              key={area}
              className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
              title="Treatment area"
            >
              {area}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {/* Prominent Edit plan affordance (PR #128, Part 3). The
              old card buried plan-level editing under the small "Edit"
              link in the Notes section, which made the timeline /
              areas / budget fields hard to find. The header button is
              the discoverable entry point; the small Notes-section
              "Edit" link below stays as a redundant entry so existing
              muscle memory still works. Renders only for active plans
              because closed plans are read-only. */}
          {!isClosed && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-md border border-neutral-300 px-2.5 py-1 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              Edit plan
            </button>
          )}
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

      {timelineLabel && (
        <div className="flex flex-col gap-0.5 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            Estimated treatment timeline
          </p>
          <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            {timelineLabel}
          </p>
          <p className="text-[11px] text-neutral-500">
            An estimate, not a guarantee. Can change as treatment progresses.
          </p>
        </div>
      )}

      {/* Planned vs actual treatment time. This is now the primary
          progress story; the legacy "X of Y estimated visits" line is
          demoted to the muted footnote below. Renders fully when an
          estimate exists (from stages or override); falls back to a
          calm "actual logged only" view for legacy/no-stage plans so
          practitioners still see how much time they have logged
          against the plan. */}
      <PlannedVsActualBlock plan={plan} />

      {/* Treatment schedule (stages) + practitioner-only notes. The
          schedule editor renders for both active and closed plans
          (closed plans show stages read-only). The notes editor only
          renders for active plans (closed plans show read-only notes
          if any). */}
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
        editing={editing}
        setEditing={setEditing}
      />

      {/* Legacy visit-count footnote. Kept so plans created before the
          multi-area + timeline reframing still show what they were
          originally targeted at, and so the data export number has a
          UI surface. Muted and below the new primary story. */}
      <p className="border-t border-dashed border-neutral-200 pt-2 text-[11px] text-neutral-500 dark:border-neutral-800">
        Legacy visit estimate: {plan.attached_count} of{" "}
        {plan.suggested_visit_count}.
      </p>

      {onClose && !isClosed && (
        <div className="flex flex-col gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="self-start rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            Close plan
          </button>
        </div>
      )}
    </div>
  );
}

// Practitioner-only budget + clinical notes for a treatment plan.
// budget_notes, practitioner_notes, treatment_areas, and
// timeline-months are nullable columns on treatment_plans (migrations
// 0034, 0038, 0051). Closed plans render the notes read-only (or omit
// if empty). Active plans show an Edit toggle that opens a compact
// form. These notes are NOT shown to clients and NOT included in any
// email.
function PlanNotesEditor({
  plan,
  clientId,
  isClosed,
  action,
  editing,
  setEditing,
}: {
  plan: TreatmentPlanWithStages;
  clientId: string;
  isClosed: boolean;
  action: ActionFn;
  // PR #128 Part 3: editing state is now owned by the parent PlanCard
  // so a header "Edit plan" button can open the editor too. The
  // existing in-notes "Edit" link still calls setEditing(true) and
  // remains a secondary discoverable entry.
  editing: boolean;
  setEditing: (next: boolean) => void;
}) {
  const [budget, setBudget] = useState(plan.budget_notes ?? "");
  const [practitioner, setPractitioner] = useState(
    plan.practitioner_notes ?? "",
  );
  const [areasDraft, setAreasDraft] = useState<string[]>(
    plan.treatment_areas && plan.treatment_areas.length > 0
      ? [...plan.treatment_areas]
      : plan.primary_area
        ? [plan.primary_area]
        : [],
  );
  const [timelineMinDraft, setTimelineMinDraft] = useState(
    plan.estimated_timeline_months_min != null
      ? String(plan.estimated_timeline_months_min)
      : "",
  );
  const [timelineMaxDraft, setTimelineMaxDraft] = useState(
    plan.estimated_timeline_months_max != null
      ? String(plan.estimated_timeline_months_max)
      : "",
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
    for (const a of areasDraft) {
      if (a.length > PRIMARY_AREA_MAX) {
        setError(
          `Each treatment area must be ${PRIMARY_AREA_MAX} characters or fewer.`,
        );
        return;
      }
    }
    const tmin = timelineMinDraft.trim();
    const tmax = timelineMaxDraft.trim();
    if (tmin && tmax) {
      const a = parseInt(tmin, 10);
      const b = parseInt(tmax, 10);
      if (Number.isFinite(a) && Number.isFinite(b) && a > b) {
        setError("Timeline from-months must be less than or equal to to-months.");
        return;
      }
    }
    const fd = new FormData();
    fd.set("plan_id", plan.id);
    fd.set("client_id", clientId);
    fd.set("budget_notes", budget);
    fd.set("practitioner_notes", practitioner);
    // Multi-area: always send treatment_areas so the action takes the
    // multi-area path (and clears both columns when areasDraft is
    // empty). One value per selected area; an empty selection sends a
    // single empty string so the field is present.
    if (areasDraft.length === 0) {
      fd.append("treatment_areas", "");
    } else {
      for (const a of areasDraft) {
        fd.append("treatment_areas", a);
      }
    }
    // Timeline: always send both fields. Empty string clears the
    // column to NULL; a number sets it.
    fd.set("estimated_timeline_months_min", tmin);
    fd.set("estimated_timeline_months_max", tmax);
    // Always re-send the existing override unchanged. This editor does
    // not edit the override directly; preserving avoids accidental
    // clears on save.
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
    setAreasDraft(
      plan.treatment_areas && plan.treatment_areas.length > 0
        ? [...plan.treatment_areas]
        : plan.primary_area
          ? [plan.primary_area]
          : [],
    );
    setTimelineMinDraft(
      plan.estimated_timeline_months_min != null
        ? String(plan.estimated_timeline_months_min)
        : "",
    );
    setTimelineMaxDraft(
      plan.estimated_timeline_months_max != null
        ? String(plan.estimated_timeline_months_max)
        : "",
    );
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
              Edit
            </button>
          )}
        </div>
        {hasNotes ? (
          <div className="flex flex-col gap-2 text-xs">
            {plan.budget_notes && (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-neutral-500">
                  Client budget notes
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
        Edit plan
      </p>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Treatment areas
        </span>
        <MultiAreaPicker
          selected={areasDraft}
          onChange={setAreasDraft}
          idPrefix={`plan-${plan.id}`}
        />
        <span className="text-[11px] text-neutral-500">
          Pick the areas this plan covers. Clearing leaves no area.
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Estimated treatment timeline
        </span>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            value={timelineMinDraft}
            onChange={(e) => setTimelineMinDraft(e.target.value)}
            placeholder="18"
            aria-label="Timeline minimum months"
            className="w-20 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <span className="text-sm text-neutral-600">to</span>
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            value={timelineMaxDraft}
            onChange={(e) => setTimelineMaxDraft(e.target.value)}
            placeholder="24"
            aria-label="Timeline maximum months"
            className="w-20 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <span className="text-sm text-neutral-600">months</span>
        </div>
        <span className="text-[11px] text-neutral-500">
          An estimate, not a guarantee. Either side optional.
        </span>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Client budget notes
        </span>
        <textarea
          rows={2}
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="e.g. $50/week; unlimited budget; tighten schedule if cost is a concern."
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <span className="text-[11px] text-neutral-500">
          What the client says they can spend or tolerate financially, like
          &ldquo;$50/week&rdquo; or &ldquo;unlimited budget.&rdquo;
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
          {pending ? "Saving…" : "Save plan"}
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

// Planned vs actual treatment time, derived per-plan from stages +
// override (planned side) and Σ session_blocks.minutes_performed
// (actual side). Uses computePlannedVsActual() from
// lib/treatment-time/plans so the same numbers appear here, in the
// schedule editor's per-stage totals, and on the session detail
// banner.
//
// Copy follows the practitioner-vocabulary rules from the audit:
// "Estimated total treatment time", "Actual logged time",
// "Estimated remaining", "Based on logged sessions", and the standing
// footnote "Estimates change as treatment progresses." Avoids
// "guaranteed", "completion date", "percent cleared", etc.
//
// This block does NOT render on any client-facing surface (public
// booking, confirmation/reminder emails, intake, cancel, reschedule).
function PlannedVsActualBlock({
  plan,
}: {
  plan: TreatmentPlanWithStages;
}) {
  const pva = computePlannedVsActual(
    plan,
    plan.stages,
    {
      minutes: plan.actual_logged_minutes,
      sessionCount: plan.actual_session_count,
    },
  );

  const hasEstimate = pva.estimatedTotalMinutes != null;
  const hasAnything =
    hasEstimate || pva.actualLoggedMinutes > 0 || pva.actualSessionCount > 0;

  // Nothing to show at all — no estimate, no logged time. Keep the card
  // quiet rather than rendering an empty block.
  if (!hasAnything) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Progress
        </p>
        {pva.actualSessionCount > 0 && (
          <p className="text-[11px] text-neutral-500 tabular-nums">
            {pva.actualSessionCount}{" "}
            {pva.actualSessionCount === 1 ? "session" : "sessions"} logged
          </p>
        )}
      </div>

      {hasEstimate ? (
        <>
          <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-neutral-500">Estimated total treatment time</dt>
              <dd className="tabular-nums text-neutral-800 dark:text-neutral-200">
                {formatMinutes(pva.estimatedTotalMinutes!)}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-500">Actual logged time</dt>
              <dd className="tabular-nums text-neutral-800 dark:text-neutral-200">
                {formatMinutes(pva.actualLoggedMinutes)}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-500">Estimated remaining</dt>
              <dd className="tabular-nums text-neutral-800 dark:text-neutral-200">
                about {formatMinutes(pva.estimatedRemainingMinutes!)}
              </dd>
            </div>
          </dl>

          {pva.plannedVsActualPercent != null && (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800"
              role="progressbar"
              aria-valuenow={pva.plannedVsActualPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Estimated progress"
            >
              <div
                className="h-full bg-emerald-500"
                style={{ width: `${pva.plannedVsActualPercent}%` }}
              />
            </div>
          )}

          <p className="text-[11px] text-neutral-500">
            Based on logged sessions. Estimates change as treatment
            progresses.
          </p>
        </>
      ) : (
        <>
          {/* No estimate yet — show the actual side alone so practitioners
              can still see time invested. */}
          {pva.actualLoggedMinutes > 0 && (
            <p className="text-xs text-neutral-700 dark:text-neutral-300 tabular-nums">
              <span className="text-neutral-500">Actual logged time:</span>{" "}
              {formatMinutes(pva.actualLoggedMinutes)}
            </p>
          )}
          <p className="text-[11px] text-neutral-500">
            Add schedule stages to enable estimated progress.
          </p>
        </>
      )}
    </div>
  );
}
