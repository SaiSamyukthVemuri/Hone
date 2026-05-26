"use client";

// Phase C: Treatment schedule (stages) editor for one treatment plan.
//
// Renders the list of stages, the inline add/edit form, and the
// estimated-total summary. Wired to four narrow server actions defined
// in app/(app)/clients/[id]/treatment-plans-actions.ts. Used inside
// TreatmentPlansCard.
//
// Estimates are local UI-only: a small formula converts (stage length,
// how often, visit length) into an approximate visit count and minute
// total. This does NOT touch lib/treatment-time — TTT actual-logged
// computations stay exactly as they are; Phase D will wire planned vs.
// actual.
//
// Vocabulary (from product copy):
//   "Treatment schedule" — the ordered list of stages on a plan
//   "Stage"              — one segment with its own timing and length
//   "How often"          — Weekly / Every 2 weeks / Monthly
//   "Visit length"       — minutes per visit
//   "Estimated total"    — derived from stages, displayed with "about"

import { useState, useTransition } from "react";
import type {
  TreatmentPlanStage,
  TreatmentPlanStageHowOftenUnit,
  TreatmentPlanStageLengthUnit,
} from "@/lib/types/database";

export type TreatmentScheduleAction = (
  formData: FormData,
) => Promise<{ ok: true } | { ok: false; error: string }>;

type Props = {
  planId: string;
  clientId: string;
  // Closed plans render the schedule read-only — practitioners must
  // reopen a plan (via a future action) to edit it.
  isClosed: boolean;
  stages: TreatmentPlanStage[];
  createStageAction: TreatmentScheduleAction;
  updateStageAction: TreatmentScheduleAction;
  deleteStageAction: TreatmentScheduleAction;
};

const HOW_OFTEN_OPTIONS: ReadonlyArray<{
  value: TreatmentPlanStageHowOftenUnit;
  label: string;
}> = [
  { value: "weekly", label: "Weekly" },
  { value: "every_2_weeks", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
];

const STAGE_LENGTH_UNIT_OPTIONS: ReadonlyArray<{
  value: TreatmentPlanStageLengthUnit;
  label: string;
}> = [
  { value: "weeks", label: "Weeks" },
  { value: "months", label: "Months" },
];

const VISIT_LENGTH_PRESETS: ReadonlyArray<number> = [15, 30, 45, 60, 90];

// ---- Estimate helpers (local; do NOT touch lib/treatment-time) ----

// Convert a stage's declared length into weeks. The factor 4 is the
// rounded "weeks per month" used in plain-English schedule estimates
// (a calendar month is actually ~4.345 weeks but practitioners think
// in 4-week blocks; we keep it simple).
function stageWeeks(stage: TreatmentPlanStage): number {
  return stage.stage_length_unit === "weeks"
    ? stage.stage_length_value
    : stage.stage_length_value * 4;
}

export function estimateStageVisits(stage: TreatmentPlanStage): number {
  const weeks = stageWeeks(stage);
  switch (stage.how_often_unit) {
    case "weekly":
      return weeks;
    case "every_2_weeks":
      return Math.ceil(weeks / 2);
    case "monthly":
      // If the stage is declared in months use it directly; if in weeks
      // approximate the month count from the weeks.
      return stage.stage_length_unit === "months"
        ? stage.stage_length_value
        : Math.ceil(weeks / 4);
  }
}

export function estimateStageMinutes(stage: TreatmentPlanStage): number {
  return estimateStageVisits(stage) * stage.visit_length_minutes;
}

export function estimatePlanTotalVisits(
  stages: ReadonlyArray<TreatmentPlanStage>,
): number {
  return stages.reduce((acc, s) => acc + estimateStageVisits(s), 0);
}

export function estimatePlanTotalMinutes(
  stages: ReadonlyArray<TreatmentPlanStage>,
): number {
  return stages.reduce((acc, s) => acc + estimateStageMinutes(s), 0);
}

// Local minute formatter so this file does not depend on lib/treatment-time.
// "0m", "45m", "2h", "2h 30m" — same shape as the TTT formatter but private
// to the schedule editor.
function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatHowOften(unit: TreatmentPlanStageHowOftenUnit): string {
  return (
    HOW_OFTEN_OPTIONS.find((o) => o.value === unit)?.label ?? unit
  );
}

function formatStageLength(stage: TreatmentPlanStage): string {
  const noun =
    stage.stage_length_unit === "weeks"
      ? stage.stage_length_value === 1
        ? "week"
        : "weeks"
      : stage.stage_length_value === 1
        ? "month"
        : "months";
  return `${stage.stage_length_value} ${noun}`;
}

// ---- Component ----

export function TreatmentScheduleEditor({
  planId,
  clientId,
  isClosed,
  stages,
  createStageAction,
  updateStageAction,
  deleteStageAction,
}: Props) {
  // One editor is open at a time per plan: either "add" or {edit: stageId}.
  const [openMode, setOpenMode] = useState<
    | { kind: "closed" }
    | { kind: "add" }
    | { kind: "edit"; stage: TreatmentPlanStage }
  >({ kind: "closed" });

  const totalVisits = estimatePlanTotalVisits(stages);
  const totalMinutes = estimatePlanTotalMinutes(stages);

  return (
    <div className="flex flex-col gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Treatment schedule
        </p>
        {stages.length > 0 && (
          <p className="text-[11px] text-neutral-500 tabular-nums">
            Estimated total: about {totalVisits}{" "}
            {totalVisits === 1 ? "visit" : "visits"} ·{" "}
            {formatMinutes(totalMinutes)}
          </p>
        )}
      </div>

      {stages.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 px-3 py-3 text-xs text-neutral-500 dark:border-neutral-700">
          <p className="font-medium text-neutral-700 dark:text-neutral-300">
            No schedule stages yet.
          </p>
          <p className="mt-0.5">
            Add stages like weekly 15-minute visits for 3 months.
          </p>
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {stages.map((stage, index) => (
            <li key={stage.id}>
              {openMode.kind === "edit" && openMode.stage.id === stage.id ? (
                <StageForm
                  mode="edit"
                  planId={planId}
                  clientId={clientId}
                  stage={stage}
                  action={updateStageAction}
                  onDone={() => setOpenMode({ kind: "closed" })}
                  onCancel={() => setOpenMode({ kind: "closed" })}
                />
              ) : (
                <StageRow
                  index={index}
                  stage={stage}
                  isClosed={isClosed}
                  planId={planId}
                  clientId={clientId}
                  deleteAction={deleteStageAction}
                  onEdit={() => setOpenMode({ kind: "edit", stage })}
                />
              )}
            </li>
          ))}
        </ol>
      )}

      {!isClosed && openMode.kind === "add" && (
        <StageForm
          mode="create"
          planId={planId}
          clientId={clientId}
          stage={null}
          action={createStageAction}
          onDone={() => setOpenMode({ kind: "closed" })}
          onCancel={() => setOpenMode({ kind: "closed" })}
        />
      )}

      {!isClosed && openMode.kind !== "add" && openMode.kind !== "edit" && (
        <button
          type="button"
          onClick={() => setOpenMode({ kind: "add" })}
          className="self-start rounded-md border border-dashed border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          + Add stage
        </button>
      )}
    </div>
  );
}

// ---- Stage display row ----

function StageRow({
  index,
  stage,
  isClosed,
  planId,
  clientId,
  deleteAction,
  onEdit,
}: {
  index: number;
  stage: TreatmentPlanStage;
  isClosed: boolean;
  planId: string;
  clientId: string;
  deleteAction: TreatmentScheduleAction;
  onEdit: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    if (
      !window.confirm(`Remove ${stage.name ?? `Stage ${index + 1}`}?`)
    ) {
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("stage_id", stage.id);
    fd.set("plan_id", planId);
    fd.set("client_id", clientId);
    startTransition(async () => {
      const r = await deleteAction(fd);
      if (!r.ok) setError(r.error);
    });
  }

  const visits = estimateStageVisits(stage);
  const minutes = estimateStageMinutes(stage);
  const label = stage.name ?? `Stage ${index + 1}`;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {label}
        </p>
        {!isClosed && (
          <div className="flex gap-1 text-[11px]">
            <button
              type="button"
              onClick={onEdit}
              disabled={pending}
              className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={pending}
              className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 dark:hover:bg-red-950 dark:hover:text-red-300"
            >
              Remove
            </button>
          </div>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px] text-neutral-600 dark:text-neutral-400">
        <div>
          <dt className="inline text-neutral-500">How often: </dt>
          <dd className="inline">{formatHowOften(stage.how_often_unit)}</dd>
        </div>
        <div>
          <dt className="inline text-neutral-500">Visit length: </dt>
          <dd className="inline tabular-nums">
            {stage.visit_length_minutes} min
          </dd>
        </div>
        <div>
          <dt className="inline text-neutral-500">For: </dt>
          <dd className="inline">{formatStageLength(stage)}</dd>
        </div>
        <div>
          <dt className="inline text-neutral-500">Estimated: </dt>
          <dd className="inline tabular-nums">
            about {visits} {visits === 1 ? "visit" : "visits"} ·{" "}
            {formatMinutes(minutes)}
          </dd>
        </div>
      </dl>
      {stage.notes && (
        <p className="whitespace-pre-wrap text-[12px] text-neutral-600 dark:text-neutral-400">
          {stage.notes}
        </p>
      )}
      {error && (
        <p className="text-[11px] text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---- Stage form (create / edit) ----

function StageForm({
  mode,
  planId,
  clientId,
  stage,
  action,
  onDone,
  onCancel,
}: {
  mode: "create" | "edit";
  planId: string;
  clientId: string;
  stage: TreatmentPlanStage | null;
  action: TreatmentScheduleAction;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(stage?.name ?? "");
  const [howOften, setHowOften] = useState<TreatmentPlanStageHowOftenUnit>(
    stage?.how_often_unit ?? "weekly",
  );
  const [visitLength, setVisitLength] = useState(
    String(stage?.visit_length_minutes ?? 15),
  );
  const [stageLengthValue, setStageLengthValue] = useState(
    String(stage?.stage_length_value ?? 3),
  );
  const [stageLengthUnit, setStageLengthUnit] =
    useState<TreatmentPlanStageLengthUnit>(stage?.stage_length_unit ?? "months");
  const [notes, setNotes] = useState(stage?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function applyPreset(minutes: number) {
    setVisitLength(String(minutes));
  }

  function submit() {
    setError(null);
    const fd = new FormData();
    if (mode === "edit" && stage) fd.set("stage_id", stage.id);
    fd.set("plan_id", planId);
    fd.set("client_id", clientId);
    fd.set("name", name.trim());
    fd.set("how_often_unit", howOften);
    fd.set("visit_length_minutes", visitLength.trim());
    fd.set("stage_length_value", stageLengthValue.trim());
    fd.set("stage_length_unit", stageLengthUnit);
    fd.set("notes", notes);
    startTransition(async () => {
      const r = await action(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onDone();
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-300 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900">
      <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
        {mode === "create" ? "Add stage" : "Edit stage"}
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Stage name (optional)
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Intensive"
          maxLength={80}
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">
            How often
          </span>
          <select
            value={howOften}
            onChange={(e) =>
              setHowOften(e.target.value as TreatmentPlanStageHowOftenUnit)
            }
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          >
            {HOW_OFTEN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">
            Visit length
          </span>
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-nowrap gap-1">
              {VISIT_LENGTH_PRESETS.map((m) => {
                const selected = visitLength === String(m);
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => applyPreset(m)}
                    aria-pressed={selected}
                    className={`flex-1 rounded-md border px-2 py-1 text-[11px] tabular-nums transition ${
                      selected
                        ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                        : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                    }`}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={5}
                max={240}
                step={5}
                value={visitLength}
                onChange={(e) => setVisitLength(e.target.value)}
                className="w-20 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
              <span className="text-[11px] text-neutral-500">min</span>
            </div>
          </div>
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          For
        </span>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={240}
            step={1}
            value={stageLengthValue}
            onChange={(e) => setStageLengthValue(e.target.value)}
            className="w-20 rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <select
            value={stageLengthUnit}
            onChange={(e) =>
              setStageLengthUnit(e.target.value as TreatmentPlanStageLengthUnit)
            }
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          >
            {STAGE_LENGTH_UNIT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Stage notes (optional)
        </span>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. weekly visits at first to build momentum"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
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
          {pending
            ? mode === "create"
              ? "Adding…"
              : "Saving…"
            : mode === "create"
              ? "Add stage"
              : "Save stage"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
