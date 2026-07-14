import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function statusBadge(s: string | null) {
  const v = s ?? "unknown";
  return <span className={`badge ${v}`}>{v}</span>;
}

function linkLabel(l: { type: string; setNo: number; part: number; variant: string }) {
  if (l.type === "PRACTICE") return `Set ${l.setNo} Part ${l.part}`;
  if (l.type === "TIMED") return `Set ${l.setNo}`;
  return l.type.charAt(0) + l.type.slice(1).toLowerCase();
}

export default async function ExamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const examId = Number(id);
  if (!Number.isFinite(examId)) notFound();

  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: {
      site: true,
      links: {
        where: { active: true },
        orderBy: [{ type: "asc" }, { variant: "asc" }, { setNo: "asc" }, { part: "asc" }],
      },
      incidents: { where: { status: "OPEN" }, include: { link: true }, orderBy: { openedAt: "desc" } },
    },
  });
  if (!exam) notFound();

  const links = exam.links;
  const problems = links.filter((l) => l.lastStatus === "down" || l.lastStatus === "degraded");
  const byType = (t: string) => links.filter((l) => l.type === t);
  const practiceVariants = [...new Set(byType("PRACTICE").map((l) => l.variant || "questions"))];

  const renderRows = (items: typeof links) =>
    items.map((l) => (
      <tr key={l.id}>
        <td>{linkLabel(l)}</td>
        <td><a href={l.url} target="_blank" rel="noreferrer">{l.url}</a></td>
        <td>{statusBadge(l.lastStatus)}</td>
        <td className="muted">{l.lastCheckAt ? l.lastCheckAt.toISOString().slice(5, 16).replace("T", " ") : "—"}</td>
      </tr>
    ));

  const section = (title: string, items: typeof links) =>
    items.length > 0 && (
      <>
        <h3>{title} <span className="muted">({items.length})</span></h3>
        <table>
          <thead><tr><th>Link</th><th>URL</th><th>Status</th><th>Checked</th></tr></thead>
          <tbody>{renderRows(items)}</tbody>
        </table>
      </>
    );

  return (
    <>
      <header className="topbar">
        <h1>
          <Link href="/">🔎</Link>{" "}
          <Link href={`/site/${exam.site.key}`}>{exam.site.name}</Link>{" "}
          <span className="muted">/ {exam.examCode}</span>
        </h1>
        <Link href={`/site/${exam.site.key}`} className="btn secondary">← Back to {exam.site.name}</Link>
      </header>

      <div className="wrap">
        <h2 style={{ marginBottom: 4 }}>{exam.examName}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {exam.examCode} · {exam.site.name} · {links.length} links{exam.notes ? ` · ${exam.notes}` : ""}
        </p>

        <div className="cards">
          <div className="card"><div className="n" style={{ color: problems.length ? "var(--down)" : "var(--up)" }}>{problems.length}</div><div className="l">Links with issues</div></div>
          <div className="card"><div className="n">{exam.incidents.length}</div><div className="l">Open incidents</div></div>
          <div className="card"><div className="n">{byType("PRACTICE").length}</div><div className="l">Practice links</div></div>
          <div className="card"><div className="n">{byType("TIMED").length}</div><div className="l">Timed links</div></div>
        </div>

        <h2>Open incidents ({exam.incidents.length})</h2>
        {exam.incidents.length === 0 ? (
          <p className="muted">No open incidents for this exam. 🎉</p>
        ) : (
          <table>
            <thead><tr><th>Link</th><th>Severity</th><th>Error</th><th>Since</th></tr></thead>
            <tbody>
              {exam.incidents.map((i) => (
                <tr key={i.id}>
                  <td><a href={i.link.url} target="_blank" rel="noreferrer">{linkLabel(i.link)}{i.link.variant ? ` (${i.link.variant})` : ""}</a></td>
                  <td>{statusBadge(i.severity)}</td>
                  <td className="muted">{i.lastError ?? ""}</td>
                  <td className="muted">{i.openedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>All links</h2>
        {section("Study guide", byType("LANDING"))}
        {practiceVariants.map((v) => (
          <div key={v}>{section(`Practice — ${v}.`, byType("PRACTICE").filter((l) => (l.variant || "questions") === v))}</div>
        ))}
        {section("Timed exams", byType("TIMED"))}
        {section("Contact", byType("CONTACT"))}
      </div>
    </>
  );
}
