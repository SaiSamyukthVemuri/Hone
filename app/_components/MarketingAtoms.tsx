import { MARKETING_PALETTE } from "./marketingNav";

// Caption with a leading 32px x 1px hairline bar. CSS uppercases the text,
// so pass title-case strings.
export function EyebrowCaption({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center text-[12px] font-medium uppercase">
      <span
        aria-hidden="true"
        className="mr-4 inline-block h-px w-8"
        style={{ backgroundColor: MARKETING_PALETTE.ink }}
      />
      <span style={{ letterSpacing: "0.2em" }}>{children}</span>
    </p>
  );
}

export function MutedCaption({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-[10px] font-medium uppercase"
      style={{ letterSpacing: "0.2em", color: MARKETING_PALETTE.muted }}
    >
      {children}
    </span>
  );
}

export function Hairline({ className = "" }: { className?: string }) {
  return (
    <div
      className={className}
      style={{ height: "1px", backgroundColor: MARKETING_PALETTE.rule }}
      role="separator"
      aria-hidden="true"
    />
  );
}
