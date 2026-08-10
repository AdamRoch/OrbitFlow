import { cn } from "@/lib/cn";

const baseField =
  "w-full rounded-xl border border-[--border] bg-[--surface-2]/70 px-3 text-sm text-[--foreground] placeholder:text-[--foreground-subtle] backdrop-blur-sm transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] focus:outline-none focus:border-[--accent] focus:ring-1 focus:ring-[--accent] focus:shadow-[0_0_0_3px_rgba(var(--glow),0.12)]";

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(baseField, "h-10", className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea className={cn(baseField, "py-2 min-h-[120px]", className)} {...props} />
  );
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(baseField, "h-10 cursor-pointer appearance-none pr-9", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%239fb2cf' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 0.75rem center",
      }}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({
  children,
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        "block text-xs font-medium text-[--foreground-muted] mb-1.5",
        className,
      )}
      {...props}
    >
      {children}
    </label>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
