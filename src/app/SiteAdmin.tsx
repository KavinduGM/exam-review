"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface SiteRow {
  id: number;
  key: string;
  name: string;
  type: string;
  baseUrl: string;
  active: boolean;
  exams: number;
  defaultSets: number;
  defaultParts: number;
  defaultTimedSets: number;
}

const TYPE_LABEL: Record<string, string> = {
  EXAM: "Exam site",
  SIMPLE: "Uptime only",
  TIMED_HOST: "Timed host",
};

export function SiteAdmin({ sites }: { sites: SiteRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ key: "", name: "", type: "EXAM", baseUrl: "", sitemapUrl: "", defaultSets: 5, defaultParts: 3, defaultTimedSets: 5 });

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setOpen(false);
      setForm({ key: "", name: "", type: "EXAM", baseUrl: "", sitemapUrl: "", defaultSets: 5, defaultParts: 3, defaultTimedSets: 5 });
      router.refresh();
    } else {
      setError(data.error || "Failed to add site");
    }
  }

  async function remove(site: SiteRow) {
    if (!confirm(`Delete "${site.name}" and all ${site.exams} of its exams/links? This can't be undone.`)) return;
    const res = await fetch(`/api/sites/${site.id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
    else alert("Delete failed");
  }

  async function toggleActive(site: SiteRow) {
    await fetch(`/api/sites/${site.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !site.active }),
    });
    router.refresh();
  }

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Sites</h2>
        <button onClick={() => setOpen((o) => !o)}>{open ? "Cancel" : "+ Add website"}</button>
      </div>

      {open && (
        <form onSubmit={add} className="site-form">
          <div className="grid">
            <label>Type
              <select value={form.type} onChange={(e) => set("type", e.target.value)}>
                <option value="EXAM">Exam site (practice / timed / contact)</option>
                <option value="SIMPLE">Uptime only (monitor every page)</option>
                <option value="TIMED_HOST">Timed host (from timed DB)</option>
              </select>
            </label>
            <label>Key<input placeholder="e.g. onlinedegreeblogs" value={form.key} onChange={(e) => set("key", e.target.value)} required /></label>
            <label>Name<input placeholder="Online Degree Blogs" value={form.name} onChange={(e) => set("name", e.target.value)} required /></label>
            <label>Base URL<input placeholder="https://onlinedegreeblogs.com" value={form.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} required /></label>
            <label>Sitemap URL (optional)<input placeholder="https://…/sitemap.xml" value={form.sitemapUrl} onChange={(e) => set("sitemapUrl", e.target.value)} /></label>
            {form.type === "EXAM" && (
              <>
                <label>Practice sets<input type="number" min={1} max={20} value={form.defaultSets} onChange={(e) => set("defaultSets", Number(e.target.value))} /></label>
                <label>Parts / set<input type="number" min={1} max={20} value={form.defaultParts} onChange={(e) => set("defaultParts", Number(e.target.value))} /></label>
              </>
            )}
            {(form.type === "EXAM" || form.type === "TIMED_HOST") && (
              <label>Timed sets<input type="number" min={0} max={20} value={form.defaultTimedSets} onChange={(e) => set("defaultTimedSets", Number(e.target.value))} /></label>
            )}
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            {form.type === "EXAM" && "Crawls landing pages and extracts practice, timed, and contact links."}
            {form.type === "SIMPLE" && "Crawls the sitemap/pages and monitors each one loads (with broken-image checks). No DB needed."}
            {form.type === "TIMED_HOST" && "Enumerates every exam from the timed database and monitors its set URLs. Needs the timed DB connected."}
          </p>
          {error && <div className="error">{error}</div>}
          <div className="row">
            <button type="submit" disabled={busy}>{busy ? "Adding…" : "Add website"}</button>
            <span className="muted">After adding, click “Collect links” to populate it.</span>
          </div>
        </form>
      )}

      <table>
        <thead><tr><th>Key</th><th>Name</th><th>Type</th><th>Base URL</th><th>Structure</th><th>Exams</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {sites.map((s) => (
            <tr key={s.id}>
              <td>{s.key}</td>
              <td>{s.name}</td>
              <td className="muted">{TYPE_LABEL[s.type] ?? s.type}</td>
              <td><a href={s.baseUrl} target="_blank" rel="noreferrer">{s.baseUrl}</a></td>
              <td className="muted">
                {s.type === "EXAM" && `${s.defaultSets}×${s.defaultParts} practice · ${s.defaultTimedSets} timed`}
                {s.type === "SIMPLE" && "all pages"}
                {s.type === "TIMED_HOST" && `${s.defaultTimedSets} timed sets`}
              </td>
              <td>{s.exams}</td>
              <td>
                <button className="linklike" onClick={() => toggleActive(s)}>
                  <span className={`badge ${s.active ? "up" : "unknown"}`}>{s.active ? "active" : "paused"}</span>
                </button>
              </td>
              <td><button className="secondary" onClick={() => remove(s)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
