"use client";

import { useState, useTransition } from "react";

export type StudioMachineRow = { profileId: string; name: string; description: string };
export type StudioMachinesState = { enabled: string[]; defaultProfileId: string | null };
export type StudioMachinesResult = { ok: true; state: StudioMachinesState } | { ok: false; error: string };

type Props = {
  models: ReadonlyArray<StudioMachineRow>;
  initial: StudioMachinesState;
  /** Server actions, passed in so this file never imports server code. Each returns the studio's state as the database now holds it. */
  setModel: (profileId: string, enabled: boolean) => Promise<StudioMachinesResult>;
  setDefault: (profileId: string | null) => Promise<StudioMachinesResult>;
};

/** Owner's "Studio machines": a switch per model and the default. Each change is saved on its own and the page then shows what the database holds. */
export function StudioMachinesForm({ models, initial, setModel, setDefault }: Props) {
  const [state, setState] = useState<StudioMachinesState>(initial);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function run(p: Promise<StudioMachinesResult>, okText: string) {
    startTransition(async () => {
      const res = await p;
      if (res.ok) {
        setState(res.state);
        setMessage({ ok: true, text: okText });
      } else {
        setMessage({ ok: false, text: res.error });
      }
    });
  }

  return (
    <div className="space-y-5" data-testid="studio-machines">
      <div>
        <h4 className="text-sm font-semibold">Machines available in sessions</h4>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Turn on the machines your studio uses. Visits already charted keep the machine they were charted with.</p>
        <ul className="mt-3 divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {models.map((m) => {
            const on = state.enabled.includes(m.profileId);
            return (
              <li key={m.profileId} className="flex min-h-[44px] items-center justify-between gap-3 px-3 py-2">
                <div>
                  <div className="text-sm font-medium">{m.name}</div>
                  <div className="text-xs text-neutral-600 dark:text-neutral-400">{m.description}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={m.name}
                  data-testid={`studio-machine-switch-${m.profileId}`}
                  disabled={pending}
                  onClick={() => run(setModel(m.profileId, !on), `${m.name} turned ${on ? "off" : "on"}.`)}
                  className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:opacity-60 ${on ? "border-neutral-900 bg-neutral-900 dark:border-neutral-100 dark:bg-neutral-100" : "border-neutral-300 bg-neutral-200 dark:border-neutral-700 dark:bg-neutral-800"}`}
                >
                  <span className={`inline-block h-5 w-5 rounded-full bg-white transition-transform dark:bg-neutral-900 ${on ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div>
        <label htmlFor="studio-machine-default" className="text-sm font-semibold">Default machine</label>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Selected automatically for new sessions.</p>
        {state.enabled.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400" data-testid="studio-machine-default-none">Enable a machine to choose a default.</p>
        ) : (
          <select
            id="studio-machine-default"
            data-testid="studio-machine-default"
            disabled={pending}
            value={state.defaultProfileId ?? ""}
            onChange={(e) => run(setDefault(e.target.value === "" ? null : e.target.value), "Default machine saved.")}
            className="mt-2 min-h-[44px] w-full max-w-sm rounded-md border border-neutral-300 bg-white px-3 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="">Ask at each visit</option>
            {models.filter((m) => state.enabled.includes(m.profileId)).map((m) => (
              <option key={m.profileId} value={m.profileId}>{m.name}</option>
            ))}
          </select>
        )}
      </div>
      <p role="status" aria-live="polite" data-testid="studio-machines-message" className={message ? (message.ok ? "text-sm text-green-700 dark:text-green-400" : "text-sm text-red-700 dark:text-red-400") : "sr-only"}>
        {message?.text ?? ""}
      </p>
    </div>
  );
}
