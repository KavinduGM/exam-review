"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Progress {
  phase?: string;
  stage?: string;
  site?: string;
  siteIndex?: number;
  siteCount?: number;
  examsFound?: number;
  linksUpserted?: number;
  checked?: number;
  reviewed?: number;
  total?: number;
  down?: number;
  degraded?: number;
  flagged?: number;
}

interface Status {
  counts?: { active: number; waiting: number; delayed: number; completed: number; failed: number } | null;
  activeJobs?: { name: string; progress: Progress | number | null; startedAt: number | null }[];
}

function describe(name: string, p: Progress | number | null): string {
  if (p == null || typeof p === "number") return `${name} running…`;
  if (p.phase === "collect")
    return `Collecting — site ${p.siteIndex}/${p.siteCount} (${p.site}) · ${p.examsFound ?? 0} exams, ${p.linksUpserted ?? 0} links`;
  if (p.phase === "uptime")
    return `Uptime — ${p.checked}/${p.total} checked · ${p.down ?? 0} down, ${p.degraded ?? 0} degraded`;
  if (p.phase === "audit" && p.stage === "checks") return `Audit — checking ${p.checked}/${p.total}`;
  if (p.phase === "audit" && p.stage === "ai-review")
    return `Audit — AI review ${p.reviewed}/${p.total} · ${p.flagged ?? 0} flagged`;
  return `${name} running…`;
}

function pct(p: Progress | number | null): number | null {
  if (p == null || typeof p === "number") return typeof p === "number" ? p : null;
  const done = p.checked ?? p.reviewed ?? p.siteIndex;
  const total = p.total ?? p.siteCount;
  if (done != null && total) return Math.min(100, Math.round((done / total) * 100));
  return null;
}

export function Activity() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const wasBusy = useRef(false);

  useEffect(() => {
    let stopped = false;
    async function tick() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok || stopped) return;
        const data: Status = await res.json();
        if (stopped) return;
        setStatus(data);
        const busy = (data.counts?.active ?? 0) > 0 || (data.counts?.waiting ?? 0) > 0;
        // When work just finished, refresh the server-rendered stats/tables.
        if (wasBusy.current && !busy) router.refresh();
        wasBusy.current = busy;
      } catch {
        /* transient — keep polling */
      }
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [router]);

  const active = status?.activeJobs?.[0];
  const waiting = status?.counts?.waiting ?? 0;
  const failed = status?.counts?.failed ?? 0;

  let label: string;
  let dotClass = "idle";
  let bar: number | null = null;

  if (active) {
    label = describe(active.name, active.progress);
    dotClass = "busy";
    bar = pct(active.progress);
  } else if (waiting > 0) {
    label = `${waiting} job(s) queued — starting…`;
    dotClass = "busy";
  } else {
    label = "Idle — no jobs running";
  }

  return (
    <div className="activity">
      <span className={`dot ${dotClass}`} />
      <span className="activity-label">{label}</span>
      {bar != null && (
        <span className="activity-bar">
          <span className="activity-bar-fill" style={{ width: `${bar}%` }} />
        </span>
      )}
      {failed > 0 && <span className="activity-failed">{failed} failed</span>}
    </div>
  );
}
