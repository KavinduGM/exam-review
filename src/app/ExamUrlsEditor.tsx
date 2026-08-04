"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Field = "landingUrl" | "practiceUrl" | "timedUrl" | "contactUrl";

const FIELDS: { key: Field; label: string; hint: string }[] = [
  { key: "landingUrl", label: "Study guide (landing)", hint: "The exam's page on the site — also what the QR code encodes." },
  { key: "practiceUrl", label: "Practice questions", hint: "Set 1 Part 1; the other sets/parts are derived from it." },
  { key: "timedUrl", label: "Timed exams", hint: "Set 1; the other timed sets are derived from it." },
  { key: "contactUrl", label: "Contact", hint: "The contact/tutor page." },
];

export interface ExamUrlState {
  collected: Record<Field, string | null>;
  overrides: Record<Field, string | null>;
}

/**
 * Edit the four entry URLs. A saved value is a manual correction that the
 * collector never overwrites; clearing the box reverts to the collected URL.
 */
export function ExamUrlsEditor({ examId, initial }: { examId: number; initial: ExamUrlState }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<Field, string>>(() => ({
    landingUrl: initial.overrides.landingUrl ?? "",
    practiceUrl: initial.overrides.practiceUrl ?? "",
    timedUrl: initial.overrides.timedUrl ?? "",
    contactUrl: initial.overrides.contactUrl ?? "",
  }));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const anyOverride = FIELDS.some((f) => initial.overrides[f.key]);

  async function save() {
    setSaving(true);
    setError("");
    setMsg("");
    const res = await fetch(`/api/admin/exam-urls/${examId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        landingUrl: values.landingUrl.trim() || null,
        practiceUrl: values.practiceUrl.trim() || null,
        timedUrl: values.timedUrl.trim() || null,
        contactUrl: values.contactUrl.trim() || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(data.error ?? `Save failed (${res.status})`);
      return;
    }
    setMsg(`Saved — ${data.linksResynced} link(s) re-pointed at the corrected URLs.`);
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="secondary" onClick={() => setEditing(true)}>✎ Fix URLs</button>
        {anyOverride && <span className="badge unknown">URLs edited</span>}
        {msg && <span className="muted" style={{ fontSize: "0.85em" }}>{msg}</span>}
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid var(--border, #2a2a35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
      <strong>Correct this exam&apos;s URLs</strong>
      <p className="muted" style={{ margin: 0, fontSize: "0.85em" }}>
        A value here replaces what collection found and is <b>never overwritten</b> by the nightly re-collect. Leave a box
        empty to keep using the collected URL. Saving re-points the monitored links immediately.
      </p>

      {FIELDS.map((f) => (
        <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.85em" }}>
            <b>{f.label}</b> <span className="muted">— {f.hint}</span>
          </span>
          <input
            value={values[f.key]}
            disabled={saving}
            placeholder={initial.collected[f.key] ?? "(none collected)"}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <span className="muted" style={{ fontSize: "0.78em" }}>
            Collected: {initial.collected[f.key] ?? "—"}
          </span>
        </label>
      ))}

      <div className="row" style={{ gap: 8 }}>
        <button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save URLs"}</button>
        <button className="secondary" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
        {anyOverride && (
          <button
            className="secondary"
            disabled={saving}
            onClick={() => {
              setValues({ landingUrl: "", practiceUrl: "", timedUrl: "", contactUrl: "" });
            }}
            title="Clear all corrections (revert to collected URLs) — then Save"
          >
            Clear all
          </button>
        )}
        {error && <span className="badge down">{error}</span>}
      </div>
    </div>
  );
}
