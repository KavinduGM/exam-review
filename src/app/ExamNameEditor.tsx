"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Inline exam-name editor. Shows the effective name with a ✎ button; saving
 * stores a manual override (displayName) that the collector never overwrites and
 * that every API returns. Clearing the box reverts to the collected name.
 */
export function ExamNameEditor({
  examId,
  collectedName,
  displayName,
  className,
}: {
  examId: number;
  collectedName: string;
  displayName: string | null;
  className?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(displayName ?? collectedName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const current = displayName?.trim() ? displayName : collectedName;
  const overridden = Boolean(displayName?.trim());

  async function save(next: string | null) {
    setSaving(true);
    setError("");
    const res = await fetch(`/api/admin/exam-name/${examId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: next }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? `Save failed (${res.status})`);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <span className={className}>
        {current}{" "}
        {overridden && (
          <span className="badge unknown" title={`Collected name: ${collectedName}`}>
            edited
          </span>
        )}{" "}
        <button
          className="secondary"
          style={{ padding: "0 6px", fontSize: "0.8em", lineHeight: 1.6 }}
          onClick={() => {
            setValue(current);
            setEditing(true);
          }}
          title="Edit the name used by the video/description system"
          aria-label={`Edit name for ${current}`}
        >
          ✎
        </button>
      </span>
    );
  }

  return (
    <span className={className} style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <input
        value={value}
        autoFocus
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save(value);
          if (e.key === "Escape") setEditing(false);
        }}
        style={{ minWidth: 280 }}
        aria-label="Exam name"
      />
      <button onClick={() => save(value)} disabled={saving || !value.trim()}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button className="secondary" onClick={() => setEditing(false)} disabled={saving}>
        Cancel
      </button>
      {overridden && (
        <button className="secondary" onClick={() => save(null)} disabled={saving} title={`Revert to: ${collectedName}`}>
          Reset
        </button>
      )}
      {error && <span className="badge down">{error}</span>}
      <span className="muted" style={{ fontSize: "0.8em", width: "100%" }}>
        Collected: {collectedName} · this name is what the description/QR APIs return.
      </span>
    </span>
  );
}
