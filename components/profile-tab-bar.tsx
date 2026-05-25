"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import type { ProfileTab } from "./profile-tab";

// Label-only rename: the URL search-param value stays "treatment" so
// existing /clients/[id]?tab=treatment links and the ProfileTab type
// continue to work unchanged. Only the visible tab text flips to
// "Sessions" — clearer because the tab is primarily about per-visit
// history + treatment plans, not the broader treatment time/goal data.
const TABS: ReadonlyArray<{ value: ProfileTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "health", label: "Health" },
  { value: "treatment", label: "Sessions" },
];

type Props = {
  active: ProfileTab;
};

export function ProfileTabBar({ active }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function pick(next: ProfileTab) {
    if (next === active) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === "overview") {
      params.delete("tab");
    } else {
      params.set("tab", next);
    }
    const qs = params.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    startTransition(() => {
      router.push(url, { scroll: true });
    });
  }

  return (
    <nav
      aria-label="Client profile sections"
      className="border-b border-neutral-200 dark:border-neutral-800"
    >
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        {TABS.map((tab) => {
          const isActive = tab.value === active;
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => pick(tab.value)}
              disabled={pending && !isActive}
              aria-current={isActive ? "page" : undefined}
              className={`relative min-h-[44px] px-1 pb-3 pt-2 text-sm font-medium transition disabled:opacity-60 ${
                isActive
                  ? "text-neutral-900 dark:text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              }`}
            >
              {tab.label}
              <span
                aria-hidden
                className={`absolute -bottom-px left-0 right-0 h-0.5 ${
                  isActive ? "bg-neutral-900 dark:bg-neutral-100" : "bg-transparent"
                }`}
              />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
