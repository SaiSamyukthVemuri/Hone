"use client";

import { useState, useTransition } from "react";
import type {
  AreaBreakdownRow,
  TotalTreatmentTime,
} from "@/lib/treatment-time/format";
import { formatMinutes, relativeLastSession } from "@/lib/treatment-time/format";
import type { TreatmentGoal } from "@/lib/types/database";

type Props = {
  clientId: string;
  totals: TotalTreatmentTime;
  breakdown: AreaBreakdownRow[];
  goal: TreatmentGoal | null;
  upsertGoalAction: (formData: FormData) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
};

const MAX_HOURS = 1000;

export function TreatmentTimeCard({
  clientId,
  totals,
  breakdown,
  goal,
  upsertGoalAction,
}: Props) {
  const lastSession = relativeLastSession(totals.lastSessionAt);

  // Skip the per-area block when there's only one bucket and it's the
  // generic "Other" because rendering it would just repeat the total.
  const showAreaBreakdown =
    breakdown.length > 1 ||
    (breakdown.length === 1 && breakdown[0].area !== "Other");

  const hasAny = totals.sessionCount > 0;

  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
        Total electrolysis treatment time
      </h2>
      <p className="mt-0.5 text-xs text-neutral-500">
        Time tracked from charted sessions. Treatment goals live in
        Treatment Plans.
      </p>

      {hasAny ? (
        <div className="mt-3">
          <p className="text-2xl font-medium tabular-nums">
            {formatMinutes(totals.totalMinutes)}
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            across {totals.sessionCount}{" "}
            {totals.sessionCount === 1 ? "session" : "sessions"}
            {lastSession ? ` · Last session ${lastSession}` : ""}
          </p>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-2xl font-medium text-neutral-400">0m</p>
          <p className="mt-1 text-xs text-neutral-500">
            Treatment time tracking is for electrolysis sessions.
          </p>
        </div>
      )}

      {showAreaBreakdown && (
        <div className="mt-5 flex flex-col gap-2">
          {breakdown.map((row) => (
            <AreaRow key={row.area} row={row} />
          ))}
        </div>
      )}

      {/* PR #194 (Chloe retest): the goal-setting UI is hidden. "Set
          treatment goal" here read as a competing treatment-plan
          surface; this card is a TRACKER. Goal data is preserved in
          the DB and the GoalSection code stays for a future move
          into Treatment Plans; only when a goal already exists do we
          keep showing its progress so prior setups lose nothing. */}
      {goal && (
        <GoalSection
          clientId={clientId}
          goal={goal}
          totalMinutes={totals.totalMinutes}
          upsertGoalAction={upsertGoalAction}
          hasAny={hasAny}
        />
      )}
    </section>
  );
}

function AreaRow({ row }: { row: AreaBreakdownRow }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      {/* A multi-area block buckets under a COMBINED label ("Cheek · Sideburn",
          lib/treatment-time/area-bucket.ts). `truncate` would cut that at the
          column edge and hide the very secondary area this breakdown exists to
          stop losing, so the label wraps instead and carries a title for the
          full string. */}
      <span
        title={row.area}
        className="w-32 shrink-0 break-words text-neutral-700 dark:text-neutral-300"
      >
        {row.area}
      </span>
      <span className="w-20 shrink-0 tabular-nums text-neutral-700 dark:text-neutral-300">
        {formatMinutes(row.minutes)}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
        <div
          className="h-full bg-neutral-700 dark:bg-neutral-300"
          style={{ width: `${Math.min(100, row.percentage)}%` }}
        />
      </div>
      <span className="w-10 shrink-0 text-right text-xs text-neutral-500 tabular-nums">
        {row.percentage}%
      </span>
    </div>
  );
}

function GoalSection({
  clientId,
  goal,
  totalMinutes,
  upsertGoalAction,
  hasAny,
}: {
  clientId: string;
  goal: TreatmentGoal | null;
  totalMinutes: number;
  upsertGoalAction: Props["upsertGoalAction"];
  hasAny: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [hours, setHours] = useState(
    goal ? String(Math.round(goal.estimated_total_minutes / 60)) : "",
  );
  const [notes, setNotes] = useState(goal?.notes ?? "");
  const [status, setStatus] = useState<TreatmentGoal["status"]>(
    goal?.status ?? "active",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("estimated_hours", hours);
    fd.set("notes", notes);
    fd.set("status", status);
    startTransition(async () => {
      const res = await upsertGoalAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setEditing(false);
    });
  }

  if (editing || (!goal && !hasAny)) {
    if (!editing) {
      // Inline prompt when there's no goal yet and the client has no
      // sessions either: don't expand the form unless the practitioner
      // explicitly opens it.
      return (
        <div className="mt-5 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-sm font-medium text-neutral-700 underline hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
          >
            Set treatment goal
          </button>
        </div>
      );
    }
    return (
      <div className="mt-5 flex flex-col gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900">
        <p className="text-sm font-medium">
          {goal ? "Edit treatment goal" : "Set treatment goal"}
        </p>
        <label className="flex flex-col gap-1.5 max-w-[12rem]">
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Estimated total (hours)
          </span>
          <input
            type="number"
            min={1}
            max={MAX_HOURS}
            step={1}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Notes (optional)
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="e.g. Density is moderate, expecting standard course"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        {goal && (
          <label className="flex flex-col gap-1.5 max-w-[16rem]">
            <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Status
            </span>
            <select
              value={status}
              onChange={(e) =>
                setStatus(e.target.value as TreatmentGoal["status"])
              }
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            >
              <option value="active">Active</option>
              <option value="revised">Revised</option>
              <option value="reached">Reached</option>
              <option value="archived">Archived</option>
            </select>
          </label>
        )}
        {error && <p className="text-xs text-red-700">{error}</p>}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setHours(
                goal ? String(Math.round(goal.estimated_total_minutes / 60)) : "",
              );
              setNotes(goal?.notes ?? "");
              setStatus(goal?.status ?? "active");
              setError(null);
            }}
            disabled={pending}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (!goal) {
    return (
      <div className="mt-5 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-sm font-medium text-neutral-700 underline hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
        >
          Set treatment goal
        </button>
      </div>
    );
  }

  const percent =
    goal.estimated_total_minutes > 0
      ? (totalMinutes / goal.estimated_total_minutes) * 100
      : 0;
  const isAtOrPast = totalMinutes >= goal.estimated_total_minutes;
  const isApproaching = !isAtOrPast && percent >= 90;
  const isReachedStatus = goal.status === "reached";

  return (
    <div className="mt-5 flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">
          Treatment goal: {formatMinutes(goal.estimated_total_minutes)} estimated
          {(isAtOrPast || isReachedStatus) && (
            <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
              Reached
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          {isAtOrPast || isApproaching ? "Reassess goal" : "Edit goal"}
        </button>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
        <div
          className={`h-full ${isAtOrPast ? "bg-emerald-500" : "bg-amber-500"}`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      <p className="text-xs text-neutral-500 tabular-nums">
        {formatMinutes(totalMinutes)} of{" "}
        {formatMinutes(goal.estimated_total_minutes)} ({Math.round(percent)}%)
      </p>
      {isApproaching && (
        <p className="text-xs italic text-neutral-600 dark:text-neutral-400">
          Approaching the original estimate.
        </p>
      )}
      {goal.notes && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-neutral-600 dark:text-neutral-400">
          {goal.notes}
        </p>
      )}
    </div>
  );
}
