import { cn } from "@/lib/cn";

/** Small pill/tag. Used for status and labels. */
export function Badge({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--accent)_30%,var(--border))] bg-[--surface-2]/70 px-2 py-0.5 text-xs font-medium backdrop-blur-sm shadow-[0_0_14px_-6px_rgba(var(--glow),0.6)]",
        className,
      )}
      style={style}
    >
      {children}
    </span>
  );
}
