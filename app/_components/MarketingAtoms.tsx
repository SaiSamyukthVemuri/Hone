import { MARKETING_PALETTE } from "./marketingNav";

// Uppercase, letter-spaced caption label. CSS uppercases the text, so pass
// title-case strings.
export function EyebrowCaption({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-[12px] font-medium uppercase"
      style={{ letterSpacing: "0.2em" }}
    >
      {children}
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
