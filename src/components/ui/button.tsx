import { cloneElement, isValidElement } from "react";
import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-[var(--accent)] text-[#04121a] hover:bg-[var(--accent-hover)] border-[color-mix(in_srgb,var(--accent)_55%,transparent)] shadow-[0_10px_30px_-12px_rgba(var(--glow),0.7)]",
  secondary:
    "bg-[--surface-2] text-[--foreground] hover:bg-[--surface-hover] border-[--border]",
  ghost:
    "bg-transparent text-[--foreground-muted] hover:bg-[--surface-hover] hover:text-[--foreground] border-transparent",
  danger:
    "bg-transparent text-[--danger] hover:bg-[--surface-hover] border-[--border] hover:border-[--danger]",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3.5 text-xs gap-1.5",
  md: "h-10 px-5 text-sm gap-2",
};

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  /** Render the child element (e.g. a <Link>) with button styles instead of a <button>. */
  asChild?: boolean;
  /** Optional trailing icon, rendered inside its own nested circular wrapper. */
  icon?: ReactNode;
};

export function Button({
  children,
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  asChild = false,
  icon,
  ...props
}: ButtonProps) {
  const classes = cn(
    "group inline-flex items-center justify-center rounded-full border font-medium transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
    VARIANTS[variant],
    SIZES[size],
    className,
  );

  const iconNode = icon ? (
    <span className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/10 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-110 dark:bg-white/10">
      {icon}
    </span>
  ) : null;

  if (asChild && isValidElement(children)) {
    // Merge our classes onto the single child element (lightweight Slot).
    // Append the trailing icon (if any) to the child's own children rather
    // than nesting, so we never produce <a> inside <a>.
    const child = children as React.ReactElement<{
      className?: string;
      children?: ReactNode;
    }>;
    return cloneElement(
      child,
      { className: cn(classes, child.props.className) },
      <>
        {child.props.children}
        {iconNode}
      </>,
    );
  }

  return (
    <button type={type} className={classes} {...props}>
      {children}
      {iconNode}
    </button>
  );
}
