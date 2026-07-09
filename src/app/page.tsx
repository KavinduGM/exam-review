import { prisma } from "@/lib/prisma";
import { RunButtons } from "./RunButtons";
import { Activity } from "./Activity";

export const dynamic = "force-dynamic";

function badge(status: string | null) {
  const s = status ?? "unknown";
  return <span className={`badge ${s}`}>{s}</span>;
}

export default async function Dashboard() {
  const [siteCount, examCount, activeLinks, downLinks, degradedLinks, openIncidents, sites, lastRuns] =
    await Promise.all([
      prisma.site.count(),
      prisma.exam.count(),
      prisma.link.count({ where: { active: true } }),
      prisma.link.count({ where: { active: true, lastStatus: "down" } }),
      prisma.link.count({ where: { active: true, lastStatus: "degraded" } }),
      prisma.incident.findMany({
        where: { status: "OPEN" },
        include: { link: { include: { exam: { include: { site: true } } } } },
        orderBy: { openedAt: "desc" },
        take: 50,
      }),
      prisma.site.findMany({
        include: { _count: { select: { exams: true } } },
        orderBy: { key: "asc" },
      }),
      prisma.checkRun.findMany({ orderBy: { startedAt: "desc" }, take: 6 }),
    ]);

  return (
    <>
      <header className="topbar">
        <h1>🔎 Web Site Auditor</h1>
        <RunButtons />
      </header>

      <div className="wrap">
        <Activity />
        <div className="cards">
          <div className="card"><div className="n">{siteCount}</div><div className="l">Sites</div></div>
          <div className="card"><div className="n">{examCount}</div><div className="l">Exams</div></div>
          <div className="card"><div className="n">{activeLinks}</div><div className="l">Active links</div></div>
          <div className="card"><div className="n" style={{ color: "var(--down)" }}>{downLinks}</div><div className="l">Down</div></div>
          <div className="card"><div className="n" style={{ color: "var(--degraded)" }}>{degradedLinks}</div><div className="l">Degraded</div></div>
          <div className="card"><div className="n">{openIncidents.length}</div><div className="l">Open incidents</div></div>
        </div>

        <h2>Sites</h2>
        <table>
          <thead><tr><th>Key</th><th>Name</th><th>Base URL</th><th>Exams</th></tr></thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.id}>
                <td>{s.key}</td>
                <td>{s.name}</td>
                <td><a href={s.baseUrl} target="_blank" rel="noreferrer">{s.baseUrl}</a></td>
                <td>{s._count.exams}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>Open incidents ({openIncidents.length})</h2>
        {openIncidents.length === 0 ? (
          <p className="muted">No open incidents. 🎉</p>
        ) : (
          <table>
            <thead><tr><th>Site</th><th>Exam</th><th>Link</th><th>Severity</th><th>Error</th><th>Since</th></tr></thead>
            <tbody>
              {openIncidents.map((i) => (
                <tr key={i.id}>
                  <td>{i.link.exam.site.name}</td>
                  <td>{i.link.exam.examName}</td>
                  <td>
                    <a href={i.link.url} target="_blank" rel="noreferrer">
                      {i.link.type}{i.link.setNo ? ` s${i.link.setNo}${i.link.part ? `p${i.link.part}` : ""}` : ""}
                    </a>
                  </td>
                  <td>{badge(i.severity)}</td>
                  <td className="muted">{i.lastError ?? ""}</td>
                  <td className="muted">{i.openedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>Recent runs</h2>
        <table>
          <thead><tr><th>Type</th><th>Started</th><th>Finished</th><th>Summary</th></tr></thead>
          <tbody>
            {lastRuns.map((r) => (
              <tr key={r.id}>
                <td>{r.type}</td>
                <td className="muted">{r.startedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                <td className="muted">{r.finishedAt ? r.finishedAt.toISOString().slice(11, 16) : "running…"}</td>
                <td className="muted"><code>{r.summary ? JSON.stringify(r.summary).slice(0, 120) : ""}</code></td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>API for the YouTube system</h2>
        <p className="muted">
          <code>GET /api/exams/&#123;site&#125;/&#123;code&#125;</code> — all links for one exam.{" "}
          <code>GET /api/exams?site=oapractice</code> — list/search exams. Both are public (no auth).
        </p>
      </div>
    </>
  );
}
