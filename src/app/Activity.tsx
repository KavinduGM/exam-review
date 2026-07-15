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
  counts?: { active: number; waiting: number; delayed: number; completed: number; failed: number; paused: number } | null;
  workers?: number;
  activeJobs?: { name: string; progress: Progress | number | null; elapsedMs: number | null }[];
  waiting?: { name: string; ageMs: number | null }[];
  failed?: { name: string; reason: string; at: number | null }[];
  recentRuns?: { type: string; durationMs: number | null; finishedAt: string | null }[];
}

function fmt(ms: number | null | undefined): string {
  if (ms == null) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function describe(name: string, p: Progress | number | null): string {
  if (p == null || typeof p === "number") return `${name} running`;
  if (p.phase === "collect")
    return `Collecting — site ${p.siteIndex}/${p.siteCount} (${p.site}) · ${p.examsFound ?? 0} exams, ${p.linksUpserted ?? 0} links`;
  if (p.phase === "uptime") return `Uptime — ${p.checked}/${p.total} · ${p.down ?? 0} down, ${p.degraded ?? 0} degraded`;
  if (p.phase === "audit" && p.stage === "checks") return `Audit — checking ${p.checked}/${p.total}`;
  if (p.phase === "audit" && p.stage === "ai-review") return `Audit — AI review ${p.reviewed}/${p.total} · ${p.flagged ?? 0} flagged`;
  return `${name} running`;
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
  const [s, setS] = useState<Status | null>(null);
  const wasBusy = useRef(false);

  useEffect(() => {
    let stopped = false;
    async function tick() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok || stopped) return;
        const data: Status = await res.json();
        if (stopped) return;
        setS(data);
        const busy = (data.counts?.active ?? 0) > 0 || (data.counts?.waiting ?? 0) > 0;
        if (wasBusy.current && !busy) router.refresh();
        wasBusy.current = busy;
      } catch {
        /* keep polling */
      }
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [router]);

  const c = s?.counts;
  const workers = s?.workers ?? 0;
  const active = s?.activeJobs?.[0];
  const waiting = c?.waiting ?? 0;
  const oldestWait = s?.waiting?.[0]?.ageMs ?? null;
  const failed = c?.failed ?? 0;
  const workerDown = workers === 0 && (waiting > 0 || (c?.active ?? 0) > 0);

  let label: string;
  let dotClass = "idle";
  let bar: number | null = null;

  if (workerDown) {
    label = `⚠ Worker not running — ${waiting} job(s) stuck in queue`;
    dotClass = "down";
  } else if (active) {
    label = `${describe(active.name, active.progress)}${active.elapsedMs != null ? ` · ${fmt(active.elapsedMs)}` : ""}`;
    dotClass = "busy";
    bar = pct(active.progress);
  } else if (waiting > 0) {
    label = `${waiting} job(s) queued — starting…`;
    dotClass = "busy";
  } else {
    label = "Idle — no jobs running";
  }

  const lastRun = s?.recentRuns?.find((r) => r.finishedAt);

  return (
    <div className={`activity ${workerDown ? "activity-alert" : ""}`}>
      <div className="row" style={{ gap: 12 }}>
        <span className={`dot ${dotClass}`} />
        <span className="activity-label">{label}</span>
        {bar != null && (
          <span className="activity-bar">
            <span className="activity-bar-fill" style={{ width: `${bar}%` }} />
          </span>
        )}
      </div>
      {s && (
        <div className="activity-meta muted">
          <span>Worker: {workers > 0 ? <b style={{ color: "var(--up)" }}>connected</b> : <b style={{ color: "var(--down)" }}>none</b>}</span>
          <span>active {c?.active ?? 0}</span>
          <span>waiting {waiting}{oldestWait != null && waiting > 0 ? ` (oldest ${fmt(oldestWait)})` : ""}</span>
          <span>completed {c?.completed ?? 0}</span>
          {failed > 0 && <span style={{ color: "var(--down)" }}>failed {failed}</span>}
          {lastRun && <span>last {lastRun.type.toLowerCase()} took {fmt(lastRun.durationMs)}</span>}
        </div>
      )}
      {failed > 0 && s?.failed?.[0] && (
        <div className="activity-meta" style={{ color: "var(--down)" }}>
          Last failure: <code>{s.failed[0].name}</code> — {s.failed[0].reason}
        </div>
      )}
      {workerDown && (
        <div className="activity-meta muted">
          The worker container isn&apos;t consuming jobs. Check its logs / restart it, then clear the queue below.
        </div>
      )}
    </div>
  );
}
