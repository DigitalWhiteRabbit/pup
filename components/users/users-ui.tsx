import type * as React from "react";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tone } from "@/components/users/users-contract";

export function Panel({
  title,
  meta,
  action,
  children,
}: {
  title: string;
  meta?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-card p-4 shadow-sm lg:p-5">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {meta && <p className="mt-1 text-sm text-muted-foreground">{meta}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export function Metric({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: React.ReactNode;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="min-h-32 min-w-0 rounded-lg border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <strong className="mt-3 block break-words text-2xl font-semibold tracking-tight sm:text-3xl">
        {value}
      </strong>
      {hint && (
        <small
          className={cn(
            "mt-2 block text-sm",
            tone === "good" && "text-success",
            tone === "warn" && "text-warning",
            tone === "bad" && "text-destructive",
            tone === "neutral" && "text-muted-foreground",
          )}
        >
          {hint}
        </small>
      )}
    </div>
  );
}

export function FilterInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        className="h-10 min-w-0 rounded-md border border-input bg-card px-3 text-sm outline-none transition placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/40"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<string | { value: string; label: string }>;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <select
        className="h-10 min-w-0 rounded-md border border-input bg-card px-3 text-sm outline-none transition focus:ring-2 focus:ring-ring/40"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => {
          const item =
            typeof option === "string"
              ? { value: option, label: option }
              : option;
          return (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          );
        })}
      </select>
    </label>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-3 py-1 text-xs font-medium",
        tone === "good" && "bg-success/15 text-success",
        tone === "warn" && "bg-warning/20 text-warning",
        tone === "bad" && "bg-destructive/15 text-destructive",
        tone === "info" && "bg-info/15 text-info",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function Info({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong
        className={cn("mt-1 block break-words text-sm", mono && "font-mono")}
      >
        {value}
      </strong>
    </div>
  );
}

export function Table({
  headers,
  rows,
}: {
  headers: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <Panel title="Результаты">
      <div className="-mx-4 overflow-x-auto sm:mx-0">
        <table className="min-w-[900px] w-full text-left text-sm">
          <thead className="bg-muted/60 text-muted-foreground">
            <tr>
              {headers.map((head) => (
                <th key={head} className="px-4 py-3 font-medium">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-muted/40">
                {row.map((cell, cellIndex) => (
                  <td key={`${rowIndex}-${cellIndex}`} className="px-4 py-4">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && <EmptyRow colSpan={headers.length} />}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function EmptyRow({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td
        className="px-4 py-8 text-center text-muted-foreground"
        colSpan={colSpan}
      >
        Ничего не найдено
      </td>
    </tr>
  );
}

export function GhostButton({
  label,
  icon,
}: {
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-accent"
    >
      {icon}
      {label}
    </button>
  );
}

export function HelpTitle() {
  return (
    <span className="group relative inline-flex">
      <HelpCircle className="h-4 w-4" />
      <span className="pointer-events-none absolute left-0 top-6 z-20 hidden w-64 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg group-hover:block">
        Активные пользователи: участники с действующим депозитом или активным
        циклом в подключенной системе.
      </span>
    </span>
  );
}

export function ChartLines() {
  return (
    <div className="h-56 rounded-lg border border-border bg-muted/30 p-4">
      <svg
        viewBox="0 0 600 180"
        role="img"
        aria-label="График динамики"
        className="h-full w-full"
      >
        <path
          d="M0 150H600M0 105H600M0 60H600M0 15H600"
          className="stroke-border"
          strokeWidth="1"
        />
        <polyline
          points="5,150 55,142 105,132 155,121 205,111 255,88 305,96 355,70 405,62 455,48 505,34 555,25 595,18"
          fill="none"
          className="stroke-foreground"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points="5,162 55,158 105,151 155,148 205,133 255,126 305,113 355,102 405,91 455,74 505,68 555,54 595,45"
          fill="none"
          className="stroke-success"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function SimpleRows({ rows }: { rows: string[][] }) {
  return (
    <div className="divide-y divide-border">
      {rows.map(([label, value, percent]) => (
        <div
          key={label}
          className="grid grid-cols-[1fr_auto_auto] gap-3 py-3 text-sm"
        >
          <span>{label}</span>
          <strong>{value}</strong>
          <StatusPill tone="info">{percent}</StatusPill>
        </div>
      ))}
    </div>
  );
}
