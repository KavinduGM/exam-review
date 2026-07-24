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
    </main>
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
    const q = onlyHealthy ? "?status=up" : "";
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
