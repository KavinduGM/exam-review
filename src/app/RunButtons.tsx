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
      <button className="secondary" onClick={logout}>Log out</button>
      {msg && <span className="muted">{msg}</span>}
    </div>
  );
}
