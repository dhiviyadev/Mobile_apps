import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { motion } from "framer-motion";
import { cls } from "@/lib/format";

const SPRING = { type: "spring", stiffness: 520, damping: 38, mass: 0.8 } as const;

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; icon?: ReactNode }>(
  function Button({ variant = "secondary", size = "md", icon, className, children, ...rest }, ref) {
    const base = "focus-ring press inline-flex items-center justify-center gap-1.5 rounded-full font-medium disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap";
    const sizes = { sm: "h-7 px-3 text-[12px]", md: "h-8 px-3.5 text-[12.5px]" };
    const variants: Record<Variant, string> = {
      primary: "btn-liquid",
      secondary: "bg-white/[0.07] text-fg border border-white/[0.1] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:bg-white/[0.11] backdrop-blur-md",
      ghost: "text-fg-2 hover:text-fg hover:bg-white/[0.06]",
      subtle: "bg-white/[0.05] text-fg-2 hover:text-fg hover:bg-white/[0.09]",
      danger: "bg-[#e6a6a6]/[0.12] text-[#f3c9c9] border border-[#e6a6a6]/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:bg-[#e6a6a6]/[0.18]",
    };
    return (
      <button ref={ref} className={cls(base, sizes[size], variants[variant], className)} {...rest}>
        {icon}
        {children}
      </button>
    );
  },
);

export function IconButton({ label, className, children, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cls(
        "focus-ring press grid h-8 w-8 place-items-center rounded-full text-fg-2 hover:bg-white/[0.08] hover:text-fg hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] disabled:opacity-40",
        active && "bg-white/[0.1] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Card({ className, children, title, action, pad = true }: { className?: string; children: ReactNode; title?: ReactNode; action?: ReactNode; pad?: boolean }) {
  return (
    <section className={cls("surface rise", pad && "p-5", className)}>
      {(title || action) && (
        <header className={cls("mb-3 flex items-center justify-between gap-2", !pad && "px-4 pt-4")}>
          {title && <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-muted">{title}</h3>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "ok" | "warn" | "danger" | "accent"; children: ReactNode; className?: string }) {
  const tones = {
    neutral: "bg-white/[0.05] text-fg-2 border-line",
    ok: "bg-[#9fc2a8]/[0.08] text-ok border-[#9fc2a8]/20",
    warn: "bg-[#d8c08a]/[0.08] text-warn border-[#d8c08a]/20",
    danger: "bg-[#e0a0a0]/[0.08] text-danger border-[#e0a0a0]/20",
    accent: "bg-accent/[0.1] text-accent-strong border-accent/25",
  };
  return <span className={cls("inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-medium backdrop-blur-sm", tones[tone], className)}>{children}</span>;
}

export function Dot({ tone = "neutral", pulse }: { tone?: "neutral" | "ok" | "warn" | "danger"; pulse?: boolean }) {
  const c = { neutral: "bg-muted", ok: "bg-ok", warn: "bg-warn", danger: "bg-danger" }[tone];
  return (
    <span className="relative inline-flex h-2 w-2">
      {pulse && <span className={cls("absolute inset-0 animate-ping rounded-full opacity-50", c)} />}
      <span className={cls("relative inline-flex h-2 w-2 rounded-full", c)} />
    </span>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cls(
        "glass-inset h-8 w-full rounded-[12px] px-3 text-[13px] text-fg placeholder:text-muted transition-[border-color,box-shadow] duration-200",
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cls("glass-inset w-full rounded-[12px] px-3 py-2 text-[13px] text-fg placeholder:text-muted transition-[border-color,box-shadow] duration-200", className)}
      {...rest}
    />
  );
});

export function Select({ value, onChange, options, className, placeholder }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string; placeholder?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cls("glass-inset h-8 rounded-[12px] px-2.5 text-[12.5px] text-fg", className)}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cls(
        "focus-ring relative flex h-[22px] w-[38px] flex-none items-center rounded-full border px-[2px] transition-colors duration-300 disabled:opacity-40",
        checked ? "justify-end border-white/25 bg-[linear-gradient(180deg,#dfe4ea,#aab1bd)] shadow-[0_0_14px_rgba(205,214,228,0.35)]" : "justify-start border-white/10 bg-black/25 shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]",
      )}
    >
      <motion.span
        layout
        transition={SPRING}
        whileTap={{ scaleX: 1.25 }}
        className={cls(
          "block h-4 w-4 rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.9)]",
          checked ? "bg-[radial-gradient(circle_at_35%_30%,#ffffff,#e9edf2_60%,#cfd5de)]" : "bg-[radial-gradient(circle_at_35%_30%,#c9ced6,#9aa1ac)]",
        )}
      />
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[6px] border border-white/10 bg-white/[0.06] px-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] font-sans text-[10.5px] text-muted">{children}</kbd>;
}

export function Empty({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="mb-1 text-muted">{icon}</div>}
      <p className="text-[13px] font-medium text-fg-2">{title}</p>
      {body && <p className="max-w-sm text-[12.5px] leading-relaxed text-muted">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-[0.08em] text-muted">{label}</p>
      <p className="mt-1 truncate font-[family-name:var(--font-display)] text-[20px] font-semibold tracking-tight text-fg">{value}</p>
      {sub && <p className="mt-0.5 truncate text-[11.5px] text-muted">{sub}</p>}
    </div>
  );
}

export function Meter({ value, tone }: { value: number; tone?: "ok" | "warn" | "danger" }) {
  const t = tone ?? (value > 90 ? "danger" : value > 75 ? "warn" : "ok");
  const color = { ok: "bg-[linear-gradient(90deg,#9aa4b4,#e9edf3)]", warn: "bg-warn/80", danger: "bg-danger/80" }[t];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/25 shadow-[inset_0_1px_1px_rgba(0,0,0,0.4)]">
      <div className={cls("h-full rounded-full shadow-[0_0_10px_rgba(220,228,240,0.35)] transition-[width] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]", color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Sparkline({ values, max = 100, height = 36 }: { values: number[]; max?: number; height?: number }) {
  if (values.length < 2) return <div style={{ height }} className="w-full rounded bg-white/[0.02]" />;
  const w = 200;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${height - (Math.min(v, max) / max) * (height - 2) - 1}`);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
      <defs>
        <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgb(220 228 240)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="rgb(220 228 240)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={`0,${height} ${pts.join(" ")} ${w},${height}`} fill="url(#spark-fill)" stroke="none" />
      <polyline points={pts.join(" ")} fill="none" stroke="rgb(230 236 245 / 0.85)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  const id = useId();
  return (
    <div className="glass-inset relative inline-flex rounded-full p-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cls("focus-ring press relative h-7 rounded-full px-3 text-[12px] font-medium transition-colors duration-200", value === o.value ? "text-fg" : "text-muted hover:text-fg-2")}
        >
          {value === o.value && (
            <motion.span
              layoutId={`seg-${id}`}
              transition={SPRING}
              className="absolute inset-0 rounded-full border border-white/[0.14] bg-white/[0.12] shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_4px_14px_-4px_rgba(0,0,0,0.5)]"
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function SectionTitle({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold tracking-tight text-fg">{title}</h1>
        {sub && <p className="mt-1 text-[13px] text-fg-2">{sub}</p>}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}
