import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function SitePage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ issues?: string }>;
}) {
  const { key } = await params;
  const { issues } = await searchParams;
  const onlyIssues = issues === "1";

  const site = await prisma.site.findUnique({ where: { key } });
  if (!site) notFound();

  const [exams, links, incidents] = await Promise.all([
    prisma.exam.findMany({ where: { siteId: site.id }, select: { id: true, examCode: true, examName: true, status: true } }),
    prisma.link.findMany({ where: { active: true, exam: { siteId: site.id } }, select: { examId: true, lastStatus: true } }),
    prisma.incident.findMany({ where: { status: "OPEN", exam: { siteId: site.id } }, select: { examId: true } }),
  ]);

  const down = new Map<number, number>();
  const degraded = new Map<number, number>();
  const inc = new Map<number, number>();
  for (const l of links) {
    if (l.lastStatus === "down") down.set(l.examId, (down.get(l.examId) ?? 0) + 1);
    else if (l.lastStatus === "degraded") degraded.set(l.examId, (degraded.get(l.examId) ?? 0) + 1);
  }
  for (const i of incidents) if (i.examId != null) inc.set(i.examId, (inc.get(i.examId) ?? 0) + 1);

  const rows = exams
    .map((e) => ({
      ...e,
      down: down.get(e.id) ?? 0,
      degraded: degraded.get(e.id) ?? 0,
      incidents: inc.get(e.id) ?? 0,
    }))
    .map((e) => ({ ...e, total: e.down + e.degraded + e.incidents }))
    .sort((a, b) => b.total - a.total || a.examCode.localeCompare(b.examCode));

  const withIssues = rows.filter((r) => r.total > 0);
  const shown = onlyIssues ? withIssues : rows;

  return (
    <>
      <header className="topbar">
        <h1>
          <Link href="/">🔎 Web Site Auditor</Link> <span className="muted">/ {site.name}</span>
        </h1>
        <Link href="/" className="btn secondary">← Back</Link>
      </header>

      <div className="wrap">
        <div className="cards">
          <div className="card"><div className="n">{rows.length}</div><div className="l">Exams</div></div>
          <div className="card"><div className="n">{withIssues.length}</div><div className="l">Exams with issues</div></div>
          <div className="card"><div className="n" style={{ color: "var(--down)" }}>{[...down.values()].reduce((a, b) => a + b, 0)}</div><div className="l">Down links</div></div>
          <div className="card"><div className="n" style={{ color: "var(--degraded)" }}>{[...degraded.values()].reduce((a, b) => a + b, 0)}</div><div className="l">Degraded links</div></div>
        </div>

        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Exams</h2>
          <div className="row">
            <Link href={`/site/${site.key}`} className={onlyIssues ? "btn secondary" : "btn"}>All ({rows.length})</Link>
            <Link href={`/site/${site.key}?issues=1`} className={onlyIssues ? "btn" : "btn secondary"}>With issues ({withIssues.length})</Link>
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="muted">{onlyIssues ? "No exams with issues. 🎉" : "No exams collected yet."}</p>
        ) : (
          <table>
            <thead><tr><th>Code</th><th>Exam</th><th>Down</th><th>Degraded</th><th>Incidents</th><th></th></tr></thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id}>
                  <td><Link href={`/exam/${e.id}`}>{e.examCode}</Link></td>
                  <td>{e.examName}{e.status === "stale" && <span className="badge unknown"> stale</span>}</td>
                  <td>{e.down > 0 ? <span className="badge down">{e.down}</span> : <span className="muted">0</span>}</td>
                  <td>{e.degraded > 0 ? <span className="badge degraded">{e.degraded}</span> : <span className="muted">0</span>}</td>
                  <td>{e.incidents > 0 ? <span className="badge down">{e.incidents}</span> : <span className="muted">0</span>}</td>
                  <td><Link href={`/exam/${e.id}`}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
