"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Channel = "OAP" | "OAG" | "NURSING" | "STATE";
const CHANNELS: { key: Channel; label: string }[] = [
  { key: "OAP", label: "OA Practice" },
  { key: "OAG", label: "OA Guides" },
  { key: "NURSING", label: "Nursing Exam Support" },
  { key: "STATE", label: "State Exams Prep" },
];

interface Landing {
  examCode: string;
  examName: string;
  landingUrl: string;
  landingStatus: string | null;
  qrFilename: string;
}
interface LandingsResp {
  channel: string;
  site: string;
  count: number;
  exams: Landing[];
}

const QR_SIZE = 512;

// Small concurrency pool so we don't fire hundreds of requests at once.
async function mapPool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

export default function QrExportPage() {
  const [fsSupported, setFsSupported] = useState(false);
  useEffect(() => setFsSupported(typeof window !== "undefined" && "showDirectoryPicker" in window), []);

  return (
    <main className="container">
      <header className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>
          <Link href="/">🔎 Web Site Auditor</Link> <span className="muted">/ QR codes</span>
        </h1>
        <Link href="/" className="btn secondary">← Back</Link>
      </header>

      <p className="muted" style={{ maxWidth: "70ch" }}>
        Generate a QR code (PNG) for every exam&apos;s landing page, per channel.{" "}
        {fsSupported ? (
          <>Pick a destination folder for each channel and the files are written straight into it.</>
        ) : (
          <>Your browser can&apos;t write to folders directly, so each channel downloads as a ZIP (use Chrome or Edge to save straight into a folder).</>
        )}{" "}
        Filenames follow the agreed format, e.g. <code>QR_D236_oaP.png</code>,{" "}
        <code>QR_HESI_Fundamentals_of_Nursing_Nursing.png</code>.
      </p>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
        {CHANNELS.map((c) => (
          <ChannelCard key={c.key} channel={c.key} label={c.label} fsSupported={fsSupported} />
        ))}
      </div>

      <PasteLinks />
    </main>
  );
}

/**
 * Ad-hoc generator: paste any links, get a ZIP of their QR codes. Use it for a
 * handful of exams you just published, without re-exporting a whole channel.
 */
function PasteLinks() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  // One per line. Optional "Name | https://…" (or "Name, https://…") to control
  // the filename; otherwise it's derived from the ?ec= code or the last path bit.
  const items = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)\s*[|,]\s*(https?:\/\/\S+)$/i);
      if (m) return { name: m[1].trim() || undefined, url: m[2] };
      const url = line.match(/https?:\/\/\S+/i)?.[0];
      return url ? { url } : null;
    })
    .filter((x): x is { url: string; name?: string } => x !== null);

  async function generate() {
    setBusy(true);
    setError("");
    setMsg(`Generating ${items.length} QR code(s)…`);
    try {
      const res = await fetch("/api/admin/qr-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items, size: QR_SIZE, format: "png" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `QR_codes_${items.length}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg(`Downloaded ${items.length} QR code(s).`);
    } catch (e) {
      setMsg("");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 10 }}>
      <strong>Generate from links</strong>
      <p className="muted" style={{ margin: 0, fontSize: "0.88em", maxWidth: "78ch" }}>
        Paste one link per line and download their QR codes as a ZIP — handy for a few exams you just
        published, without re-exporting the whole channel. To choose the filename, write{" "}
        <code>Name | https://…</code>; otherwise it&apos;s taken from the exam code in the link.
      </p>
      <textarea
        rows={6}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        placeholder={"https://oapractice.com/d310\nQR_D311_oaP | https://oapractice.com/d311"}
        style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: "12.5px" }}
      />
      <div className="row" style={{ gap: 8 }}>
        <button onClick={generate} disabled={busy || items.length === 0}>
          {busy ? "Generating…" : `Generate ${items.length || ""} QR${items.length === 1 ? "" : "s"} → ZIP`}
        </button>
        <button className="secondary" onClick={() => { setText(""); setMsg(""); setError(""); }} disabled={busy}>
          Clear
        </button>
        {msg && <span className="muted" style={{ fontSize: "0.85em" }}>{msg}</span>}
        {error && <span className="badge down">{error}</span>}
      </div>
    </section>
  );
}

function ChannelCard({ channel, label, fsSupported }: { channel: Channel; label: string; fsSupported: boolean }) {
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [dirName, setDirName] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [preview, setPreview] = useState<Landing[] | null>(null);
  const [onlyHealthy, setOnlyHealthy] = useState(true);
  const [onlyNew, setOnlyNew] = useState(false);
  const [newDays, setNewDays] = useState(7);

  async function chooseFolder() {
    try {
      // File System Access API — not in TS lib.dom yet.
      const handle = await (window as unknown as { showDirectoryPicker: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: "readwrite" });
      setDirHandle(handle);
      setDirName(handle.name);
      setMsg("");
    } catch {
      /* user cancelled the picker */
    }
  }

  async function fetchLandings(): Promise<LandingsResp> {
    const params = new URLSearchParams();
    if (onlyHealthy) params.set("status", "up");
    if (onlyNew) params.set("days", String(newDays));
    const q = params.toString() ? `?${params}` : "";
    const res = await fetch(`/api/landings/${channel}${q}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`landings ${res.status}`);
    return res.json();
  }

  async function loadPreview() {
    setBusy(true);
    setMsg("Loading exam list…");
    try {
      const data = await fetchLandings();
      setPreview(data.exams);
      setMsg(`${data.exams.length} exam(s)${onlyHealthy ? " with a healthy landing page" : ""}.`);
    } catch (e) {
      setMsg(`Failed to load: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    setProgress(null);
    setMsg("Loading exam list…");
    try {
      const data = await fetchLandings();
      const exams = data.exams;
      if (exams.length === 0) {
        setMsg("No exams to export.");
        return;
      }
      setProgress({ done: 0, total: exams.length });

      const usingFs = fsSupported && dirHandle;
      // Lazy-load the zip lib only when we actually need the fallback.
      const zip = usingFs ? null : new (await import("jszip")).default();
      let done = 0;

      await mapPool(exams, 6, async (exam) => {
        const res = await fetch(`/api/qr/${data.site}/${encodeURIComponent(exam.examCode)}?size=${QR_SIZE}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`QR ${exam.examCode} ${res.status}`);
        const blob = await res.blob();
        if (usingFs && dirHandle) {
          const fh = await dirHandle.getFileHandle(exam.qrFilename, { create: true });
          const w = await fh.createWritable();
          await w.write(blob);
          await w.close();
        } else if (zip) {
          zip.file(exam.qrFilename, blob);
        }
        done++;
        setProgress({ done, total: exams.length });
      });

      if (zip) {
        const out = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(out);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${channel}_QR_codes.zip`;
        a.click();
        URL.revokeObjectURL(url);
        setMsg(`Downloaded ${done} QR code(s) as ${channel}_QR_codes.zip`);
      } else {
        setMsg(`Saved ${done} QR code(s) to “${dirName}”. ✅`);
      }
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const canGenerate = !busy && (!fsSupported || dirHandle);

  return (
    <section style={{ border: "1px solid var(--border, #2a2a35)", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>{channel}</strong>
        <span className="muted" style={{ fontSize: "0.85em" }}>{label}</span>
      </div>

      {fsSupported && (
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <button className="secondary" onClick={chooseFolder} disabled={busy}>
            {dirHandle ? "Change folder" : "Choose folder"}
          </button>
          {dirName ? <span className="muted" style={{ fontSize: "0.85em" }}>📁 {dirName}</span> : <span className="muted" style={{ fontSize: "0.85em" }}>no folder chosen</span>}
        </div>
      )}

      <label className="row" style={{ gap: 6, alignItems: "center", fontSize: "0.85em" }}>
        <input type="checkbox" checked={onlyHealthy} onChange={(e) => setOnlyHealthy(e.target.checked)} disabled={busy} />
        Only exams with a healthy landing page
      </label>

      <label className="row" style={{ gap: 6, alignItems: "center", fontSize: "0.85em" }}>
        <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} disabled={busy} />
        Only exams added in the last
        <input
          type="number"
          min={1}
          max={365}
          value={newDays}
          disabled={busy || !onlyNew}
          onChange={(e) => setNewDays(Math.max(1, Number(e.target.value) || 7))}
          style={{ width: 64 }}
        />
        days
      </label>

      <div className="row" style={{ gap: 8 }}>
        <button onClick={generate} disabled={!canGenerate}>
          {fsSupported ? "Generate & Save" : "Generate & Download ZIP"}
        </button>
        <button className="secondary" onClick={loadPreview} disabled={busy}>Preview names</button>
      </div>

      {progress && (
        <div className="muted" style={{ fontSize: "0.85em" }}>
          {progress.done}/{progress.total}
          <div style={{ height: 6, background: "var(--border, #2a2a35)", borderRadius: 4, marginTop: 4, overflow: "hidden" }}>
            <div style={{ width: `${(progress.done / progress.total) * 100}%`, height: "100%", background: "var(--accent, #4f8cff)" }} />
          </div>
        </div>
      )}

      {msg && <div className="muted" style={{ fontSize: "0.85em" }}>{msg}</div>}

      {preview && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: "0.85em" }} className="muted">{preview.length} filename(s)</summary>
          <ul style={{ margin: "6px 0 0 0", paddingLeft: 16, fontSize: "0.8em", maxHeight: 220, overflow: "auto" }}>
            {preview.map((e) => (
              <li key={e.examCode}>
                <code>{e.qrFilename}</code>{" "}
                {e.landingStatus && e.landingStatus !== "up" && <span className="badge degraded">{e.landingStatus}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
