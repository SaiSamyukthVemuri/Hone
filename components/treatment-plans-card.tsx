"use client";

import { useState, useTransition } from "react";
import type { TreatmentPlanWithCount } from "@/lib/treatment-plans/queries";
import { FormattedDateTime } from "@/components/formatted-date-time";

type Props = {
  clientId: string;
  plans: TreatmentPlanWithCount[];
  createAction: (formData: FormData) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  closeAction: (formData: FormData) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  practitionerNames: Record<string, string>;
};

const MAX_NAME = 100;
const MAX_VISITS = 200;

export function TreatmentPlansCard({
  clientId,
  plans,
  createAction,
  closeAction,
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
      setError(`Visit count target must be between 1 and ${MAX_VISITS}.`);
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
          simple target and that phased plans (cadence + visit length +
          budget notes) are the next iteration. Calm neutral palette so
          it does not read as a warning. UI/copy only — no field or
          behavior change. */}
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-xs dark:border-neutral-800 dark:bg-neutral-900">
        <p className="font-medium text-neutral-800 dark:text-neutral-200">
          Phased treatment plans are coming
        </p>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">
          Soon you&rsquo;ll be able to plan stages like weekly 15-minute
          visits for 3 months, then monthly maintenance visits. This current
          plan is a simple target.
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
              practitionerNames={practitionerNames}
              pending={pending}
              onClose={() => submitClose(p.id)}
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
                practitionerNames={practitionerNames}
                pending={pending}
                onClose={null}
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
              Visit count target
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
            Use this as a rough target for now. Phased plans with cadence,
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
  practitionerNames,
  pending,
  onClose,
}: {
  plan: TreatmentPlanWithCount;
  practitionerNames: Record<string, string>;
  pending: boolean;
  onClose: (() => void) | null;
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
