import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "./api";

export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (d) => live && (setData(d), setError(null)),
      (e: unknown) => live && setError(e instanceof ApiError ? e.message : "Could not load this. Try again."),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload };
}

export function Pill({ tone, children }: { tone: "ok" | "warn" | "bad"; children: ReactNode }) {
  return <span className={`pill p-${tone}`}>{children}</span>;
}

export function Intro({ label, title, sub, panel }: { label: string; title: ReactNode; sub: string; panel?: ReactNode }) {
  return (
    <section className="intro wrap">
      <div style={{ flex: "1 1 420px", minWidth: 0 }}>
        <div className="lab">{label}</div>
        <h1 className="h1" style={{ marginTop: 14 }}>{title}</h1>
        <p className="sub">{sub}</p>
      </div>
      {panel}
    </section>
  );
}

export function Note({ tone, children }: { tone?: "ok" | "err" | "warn"; children: ReactNode }) {
  return <div className={`note ${tone ?? ""}`} role={tone === "err" ? "alert" : "status"}>{children}</div>;
}

export function Busy({ children }: { children: ReactNode }) {
  return (
    <span>
      <span className="spin" aria-hidden="true" />
      {children}
    </span>
  );
}

export const letter = (s: string): string => s.trim().charAt(0).toUpperCase() || "?";

export const KIND_LABEL: Record<string, string> = {
  allowance_set: "Allowance set",
  set_aside: "Set aside for a request",
  set_aside_release: "Set-aside released",
  guard_allow: "Checked and allowed",
  guard_ask: "Needs your OK",
  guard_deny: "Turned down",
  owner_approved: "You approved",
  owner_declined: "You declined",
  payment_captured: "Paid",
  payout_sent: "Shop paid",
  refund_received: "Refund received",
  dispute_opened: "Dispute opened",
  note: "Note",
};
