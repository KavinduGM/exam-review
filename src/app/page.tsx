import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { RunButtons } from "./RunButtons";
import { Activity } from "./Activity";
import { SiteAdmin } from "./SiteAdmin";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const [siteCount, examCount, activeLinks, downLinks, degradedLinks, openIncidentCount, sites, lastRuns, lastCollect] =
    await Promise.all([
      prisma.site.count(),
      prisma.exam.count(),
      prisma.link.count({ where: { active: true } }),
      prisma.link.count({ where: { active: true, lastStatus: "down" } }),
      prisma.link.count({ where: { active: true, lastStatus: "degraded" } }),
      prisma.incident.count({ where: { status: "OPEN" } }),
      prisma.site.findMany({
        include: { _count: { select: { exams: true } }, group: true },
        orderBy: { key: "asc" },
      }),
      prisma.checkRun.findMany({ orderBy: { startedAt: "desc" }, take: 6 }),
      prisma.checkRun.findFirst({ where: { type: "COLLECT", finishedAt: { not: null } }, orderBy: { startedAt: "desc" } }),
    ]);

  // Per-site issue counts for the drill-down (down/degraded links + open incidents).
  const siteIssues = await Promise.all(
    sites.map(async (s) => {
      const [down, degraded, incidents] = await Promise.all([
        prisma.link.count({ where: { active: true, lastStatus: "down", exam: { siteId: s.id } } }),
        prisma.link.count({ where: { active: true, lastStatus: "degraded", exam: { siteId: s.id } } }),
        prisma.incident.count({ where: { status: "OPEN", exam: { siteId: s.id } } }),
      ]);
      return { key: s.key, name: s.name, down, degraded, incidents, total: down + degraded + incidents };
    }),
  );

  const lastAudit = await prisma.checkRun.findFirst({
    where: { type: "AUDIT", finishedAt: { not: null } },
    orderBy: { startedAt: "desc" },
  });
  const auditSummary = (lastAudit?.summary ?? null) as null | {
    flowsChecked?: number;
    flowsBroken?: number;
    brokenFlows?: { siteKey: string; examCode: string; variant: string; upParts: number; totalParts: number; firstBroken: string | null; homeOk: boolean }[];
  };

  const groups = await prisma.siteGroup.findMany({ include: { sites: { select: { key: true } } }, orderBy: { key: "asc" } });

  const linkReports = await prisma.linkReport.findMany({
    where: { status: { in: ["OPEN", "ESCALATED"] } },
    orderBy: { reportedAt: "desc" },
    take: 20,
    include: { link: { include: { exam: { include: { site: true } } } } },
  });

  // AI review cost accounting (from stored per-review token usage).
  const now = Date.now();
  const since = (days: number) => new Date(now - days * 86400_000);
  const [costAll, cost30, cost7] = await Promise.all([
    prisma.checkResult.aggregate({ _sum: { aiCostUsd: true }, _count: { aiCostUsd: true } }),
    prisma.checkResult.aggregate({ _sum: { aiCostUsd: true }, _count: { aiCostUsd: true }, where: { checkedAt: { gte: since(30) } } }),
    prisma.checkResult.aggregate({ _sum: { aiCostUsd: true }, _count: { aiCostUsd: true }, where: { checkedAt: { gte: since(7) } } }),
  ]);
  const usd = (n: number | null | undefined) => `$${(n ?? 0).toFixed(2)}`;

  const coverage = (lastCollect?.summary ?? null) as null | {
    dbConnected?: boolean;
    dbTimedExams?: number;
    dbPracticeExams?: number;
    perSite?: {
      siteKey: string;
      examsFound: number;
      dbSeeded: number;
      timedExpected: number;
      timedCollected: number;
      practiceValidated: number;
    }[];
  };

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
          <div className="card"><div className="n">{openIncidentCount}</div><div className="l">Open incidents</div></div>
        </div>

        <h2>AI review cost</h2>
        <div className="cards">
          <div className="card"><div className="n">{usd(cost7._sum.aiCostUsd)}</div><div className="l">Last 7 days</div></div>
          <div className="card"><div className="n">{usd(cost30._sum.aiCostUsd)}</div><div className="l">Last 30 days</div></div>
          <div className="card"><div className="n">{usd(costAll._sum.aiCostUsd)}</div><div className="l">All time</div></div>
          <div className="card"><div className="n">{costAll._count.aiCostUsd}</div><div className="l">AI reviews</div></div>
        </div>
        <p className="muted" style={{ marginTop: -8 }}>
          Cost of Claude visual reviews (screenshots + vision). Tier-1 HTTP/content/image checks and uptime are free.
          Rates are configurable via <code>ANTHROPIC_PRICING_JSON</code>.
        </p>

        <SiteAdmin
          sites={sites.map((s) => ({
            id: s.id,
            key: s.key,
            name: s.name,
            type: s.type,
            group: s.group?.key ?? "—",
            baseUrl: s.baseUrl,
            active: s.active,
            exams: s._count.exams,
            defaultSets: s.defaultSets,
            defaultParts: s.defaultParts,
            defaultTimedSets: s.defaultTimedSets,
          }))}
        />

        <h2>Collection coverage {coverage?.dbConnected === false && <span className="muted">(DB not connected — crawl only)</span>}</h2>
        {!coverage ? (
          <p className="muted">No collection run yet. Click “Collect links”.</p>
        ) : (
          <>
            {coverage.dbConnected && (
              <p className="muted">
                Databases: <b>{coverage.dbTimedExams ?? 0}</b> timed exams, <b>{coverage.dbPracticeExams ?? 0}</b> practice exams known.
              </p>
            )}
            <table>
              <thead>
                <tr><th>Site</th><th>Exams</th><th>From DB (seeded)</th><th>Timed collected / expected</th><th>Practice verified</th></tr>
              </thead>
              <tbody>
                {(coverage.perSite ?? []).map((s) => {
                  const gap = (s.timedExpected ?? 0) - (s.timedCollected ?? 0);
                  return (
                    <tr key={s.siteKey}>
                      <td>{s.siteKey}</td>
                      <td>{s.examsFound}</td>
                      <td>{s.dbSeeded > 0 ? s.dbSeeded : <span className="muted">—</span>}</td>
                      <td>
                        {s.timedExpected > 0 ? (
                          <>
                            {s.timedCollected}/{s.timedExpected}{" "}
                            {gap > 0 ? <span className="badge down">{gap} missing</span> : <span className="badge up">complete</span>}
                          </>
                        ) : s.timedCollected > 0 ? (
                          <>
                            {s.timedCollected} <span className="muted">(shared — DB back_links point to a sister site)</span>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>{s.practiceValidated}{coverage.dbConnected ? "" : <span className="muted"> (n/a)</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        {auditSummary && (
          <>
            <h2>
              Practice flow{" "}
              <span className="muted">
                ({auditSummary.flowsChecked ?? 0} checked, {auditSummary.flowsBroken ?? 0} broken — last weekly audit)
              </span>
            </h2>
            {(auditSummary.brokenFlows?.length ?? 0) === 0 ? (
              <p className="muted">All practice flows pass (every Set→Part sequence + home page loads). 🎉</p>
            ) : (
              <table>
                <thead><tr><th>Site</th><th>Exam</th><th>Subdomain</th><th>Parts up</th><th>Problem</th></tr></thead>
                <tbody>
                  {auditSummary.brokenFlows!.map((f, i) => (
                    <tr key={i}>
                      <td>{f.siteKey}</td>
                      <td>{f.examCode}</td>
                      <td className="muted">{f.variant}</td>
                      <td>{f.upParts}/{f.totalParts}</td>
                      <td>{f.firstBroken ? <span className="badge down">breaks at {f.firstBroken}</span> : !f.homeOk ? <span className="badge down">home page 404</span> : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        <h2>Issues by site ({openIncidentCount} open incident{openIncidentCount === 1 ? "" : "s"})</h2>
        <p className="muted">Pick a site to see its exams ranked by issues, then open one exam to see just its problems.</p>
        <table>
          <thead><tr><th>Site</th><th>Down</th><th>Degraded</th><th>Open incidents</th><th></th></tr></thead>
          <tbody>
            {siteIssues.map((s) => (
              <tr key={s.key}>
                <td><Link href={`/site/${s.key}`}>{s.name}</Link></td>
                <td>{s.down > 0 ? <span className="badge down">{s.down}</span> : <span className="muted">0</span>}</td>
                <td>{s.degraded > 0 ? <span className="badge degraded">{s.degraded}</span> : <span className="muted">0</span>}</td>
                <td>{s.incidents > 0 ? <span className="badge down">{s.incidents}</span> : <span className="muted">0</span>}</td>
                <td><Link href={`/site/${s.key}`}>View exams →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>

        {linkReports.length > 0 && (
          <>
            <h2>Reported by description system ({linkReports.length})</h2>
            <p className="muted">
              Links the YouTube-description generator flagged as broken. We re-check them every sweep; a recovery
              webhook fires when they come back, and you get an email if one stays down past the deadline.
            </p>
            <table>
              <thead><tr><th>Exam</th><th>URL</th><th>Status</th><th>Reported</th><th>Last error</th></tr></thead>
              <tbody>
                {linkReports.map((r) => (
                  <tr key={r.id}>
                    <td>{r.link ? `${r.link.exam.site.name} · ${r.link.exam.examCode}` : <span className="muted">unregistered</span>}</td>
                    <td><a href={r.url} target="_blank" rel="noreferrer">{r.url.length > 60 ? r.url.slice(0, 60) + "…" : r.url}</a></td>
                    <td><span className={`badge ${r.status === "ESCALATED" ? "down" : "degraded"}`}>{r.status.toLowerCase()}</span></td>
                    <td className="muted">{r.reportedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                    <td className="muted">{r.lastError ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
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

        <h2>Exam groups &amp; export (for the YouTube system)</h2>
        <p className="muted">
          Exams are grouped by brand. OAP + OAG share one exam name; nursing/state are standalone.
          The grouped export returns every link under the canonical exam name (timed deduped).
        </p>
        <table>
          <thead><tr><th>Group</th><th>Name</th><th>Prefix</th><th>Sites</th><th>Export</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td>{g.key}</td>
                <td>{g.name}</td>
                <td className="muted">{g.namePrefix || "—"}</td>
                <td className="muted">{g.sites.map((s) => s.key).join(", ") || "—"}</td>
                <td><code>/api/exam/{g.key}/&#123;code&#125;</code></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: 8 }}>
          <code>GET /api/exam/&#123;group&#125;/&#123;code&#125;</code> — grouped links for one exam ·{" "}
          <code>GET /api/exam-groups?group=oa</code> — list a group&apos;s exams. Public (no auth).
        </p>
        <p className="muted">
          <b>Description API (for your YouTube generator):</b>{" "}
          <code>GET /api/description/&#123;site&#125;/&#123;code&#125;</code> — the 4 entry links (study guide,
          practice, timed, contact) + a ready-to-paste block for one exam on one channel. Requires the{" "}
          <code>DESCRIPTION_API_KEY</code> (send as <code>x-api-key</code> header or <code>?key=</code>).
        </p>
      </div>
    </>
  );
}
