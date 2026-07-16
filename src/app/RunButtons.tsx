"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RunButtons() {
  const router = useRouter();
  const [msg, setMsg] = useState("");

  async function run(job: "collect" | "uptime" | "audit") {
    setMsg(`Queuing ${job}…`);
    const res = await fetch(`/api/run/${job}`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setMsg(res.ok ? `Queued ${job} (job ${data.jobId})` : `Failed: ${data.error}`);
    setTimeout(() => router.refresh(), 1500);
  }

  async function clearQueue() {
    if (!confirm("Clear all queued jobs and failures? (A currently-running job isn't affected.)")) return;
    setMsg("Clearing queue…");
    const res = await fetch("/api/queue/clear", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setMsg(res.ok ? `Cleared ${data.cleared} queued job(s)` : `Failed: ${data.error}`);
    setTimeout(() => router.refresh(), 1000);
  }

  async function purgeStale() {
    if (!confirm("Delete superseded 'stale' exams (old slug-coded duplicates that now have a clean-code active row)?\n\nSafe: only removes exams that have an active replacement. Stale exams without a replacement are kept for review.")) return;
    setMsg("Purging stale exams…");
    const res = await fetch("/api/exams/purge-stale", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setMsg(
      res.ok
        ? `Removed ${data.deleted} superseded exam(s)${data.kept?.length ? ` · kept ${data.kept.length} for review` : ""}`
        : `Failed: ${data.error}`,
    );
    setTimeout(() => router.refresh(), 1200);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="row">
      <button onClick={() => run("collect")}>Collect links</button>
      <button onClick={() => run("uptime")}>Run uptime</button>
      <button onClick={() => run("audit")}>Run weekly audit</button>
      <button className="secondary" onClick={clearQueue}>Clear queue</button>
      <button className="secondary" onClick={purgeStale}>Purge stale exams</button>
      <button className="secondary" onClick={logout}>Log out</button>
      {msg && <span className="muted">{msg}</span>}
    </div>
  );
}
