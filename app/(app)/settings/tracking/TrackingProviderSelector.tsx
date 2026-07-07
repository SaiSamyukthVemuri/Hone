"use client";

import { useState } from "react";
import {
  PROVIDER_REGISTRY,
  VIDEO_COMING_SOON_FALLBACK,
  type ProviderRegistryEntry,
} from "@/lib/conversion/provider-registry";
import { TrackingProviderForm } from "./TrackingProviderForm";

type Result = { ok: true; last4?: string | null } | { ok: false; error: string };
type Action = (formData: FormData) => Promise<Result>;

type MetaCurrent = {
  enabled: boolean;
  browserTagId: string | null;
  testEventCode: string | null;
  tokenLast4: string | null;
  tokenStatus: string;
} | null;

// Shared read-only bits (help links, video fallback, data-safety note).
function HelpLinks({ entry }: { entry: ProviderRegistryEntry }) {
  if (entry.helpLinks.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Official help
      </span>
      <ul className="flex flex-col gap-0.5">
        {entry.helpLinks.map((l) => (
          <li key={l.href}>
            <a
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-700 underline dark:text-blue-300"
            >
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VideoNote({ entry }: { entry: ProviderRegistryEntry }) {
  if (entry.videoUrl) {
    return (
      <a
        href={entry.videoUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-blue-700 underline dark:text-blue-300"
      >
        Official video walkthrough
      </a>
    );
  }
  return <p className="text-xs italic text-neutral-500">{VIDEO_COMING_SOON_FALLBACK}</p>;
}

function DataSafety({ entry }: { entry: ProviderRegistryEntry }) {
  return (
    <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
      {entry.privacyNote}
    </p>
  );
}

function SetupSections({ entry }: { entry: ProviderRegistryEntry }) {
  return (
    <div className="flex flex-col gap-3">
      {entry.setupSections.map((s) => (
        <div key={s.title} className="flex flex-col gap-1">
          <h5 className="text-sm font-medium">{s.title}</h5>
          <ol className="ml-4 list-decimal text-sm text-neutral-700 dark:text-neutral-300">
            {s.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function MetaPanel({
  entry,
  metaCurrent,
  saveAction,
  clearTokenAction,
}: {
  entry: ProviderRegistryEntry;
  metaCurrent: MetaCurrent;
  saveAction: Action;
  clearTokenAction: Action;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold">How to get your Meta details</h4>
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          Available now
        </span>
      </div>
      <SetupSections entry={entry} />
      <DataSafety entry={entry} />
      <HelpLinks entry={entry} />
      <VideoNote entry={entry} />

      {/* Editable setup — the only provider with token fields + save. */}
      <TrackingProviderForm
        provider="meta"
        providerLabel={entry.displayName}
        current={metaCurrent}
        saveAction={saveAction}
        clearTokenAction={clearTokenAction}
      />
    </div>
  );
}

function ComingSoonPanel({ entry }: { entry: ProviderRegistryEntry }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-neutral-200 p-5 opacity-95 dark:border-neutral-800">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold">{entry.displayName}</h4>
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
          Coming soon
        </span>
      </div>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">{entry.purpose}</p>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Future requirements
        </span>
        <ul className="ml-4 list-disc text-sm text-neutral-700 dark:text-neutral-300">
          {entry.requiredFields.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
      <p className="text-xs italic text-neutral-500">
        This provider is supported by Hone&rsquo;s tracking architecture, but the
        sender is not enabled yet — no token can be added and nothing is sent.
      </p>
      <DataSafety entry={entry} />
      <HelpLinks entry={entry} />
      <VideoNote entry={entry} />
      {/* Intentionally NO token fields, NO form, NO save action. */}
    </div>
  );
}

export function TrackingProviderSelector({
  metaCurrent,
  saveAction,
  clearTokenAction,
}: {
  metaCurrent: MetaCurrent;
  saveAction: Action;
  clearTokenAction: Action;
}) {
  const [selected, setSelected] = useState<string>("meta");
  const entry =
    PROVIDER_REGISTRY.find((p) => p.provider === selected) ?? PROVIDER_REGISTRY[0];

  return (
    <div className="flex flex-col gap-4">
      <label className="flex max-w-[24rem] flex-col gap-1 text-sm">
        <span className="font-medium">Provider</span>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        >
          {PROVIDER_REGISTRY.map((p) => (
            <option key={p.provider} value={p.provider}>
              {p.displayName}
              {p.status === "coming_soon" ? " — Coming soon" : ""}
            </option>
          ))}
        </select>
      </label>

      {entry.status === "available" && entry.editable ? (
        <MetaPanel
          entry={entry}
          metaCurrent={metaCurrent}
          saveAction={saveAction}
          clearTokenAction={clearTokenAction}
        />
      ) : (
        <ComingSoonPanel entry={entry} />
      )}
    </div>
  );
}
