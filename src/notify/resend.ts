import { Resend } from "resend";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const client = env.resend.enabled ? new Resend(env.resend.apiKey) : null;

async function send(subject: string, html: string): Promise<void> {
  if (!client || env.resend.to.length === 0) {
    logger.info({ subject }, "email disabled (no RESEND_API_KEY / ALERT_TO) — skipping send");
    return;
  }
  try {
    await client.emails.send({ from: env.resend.from, to: env.resend.to, subject, html });
    logger.info({ subject }, "alert email sent");
  } catch (err) {
    logger.error({ err, subject }, "failed to send alert email");
  }
}

export interface DownItem {
  exam: string;
  site: string;
  type: string;
  url: string;
  error: string;
}

/** Immediate alert when links go down during an uptime sweep. */
export async function sendDownAlert(items: DownItem[]): Promise<void> {
  if (items.length === 0) return;
  const rows = items
    .map(
      (i) =>
        `<tr><td>${esc(i.site)}</td><td>${esc(i.exam)}</td><td>${esc(i.type)}</td><td>${esc(
          i.error,
        )}</td><td><a href="${esc(i.url)}">link</a></td></tr>`,
    )
    .join("");
  await send(
    `🔴 ${items.length} link(s) down — Web Site Auditor`,
    `<h2>${items.length} link(s) just went down</h2>
     <table border="1" cellpadding="6" cellspacing="0">
       <tr><th>Site</th><th>Exam</th><th>Type</th><th>Error</th><th>URL</th></tr>${rows}
     </table>`,
  );
}

/** Recovery notice when previously-down links come back. */
export async function sendRecoveryAlert(items: DownItem[]): Promise<void> {
  if (items.length === 0) return;
  const rows = items
    .map((i) => `<tr><td>${esc(i.site)}</td><td>${esc(i.exam)}</td><td>${esc(i.type)}</td><td><a href="${esc(i.url)}">link</a></td></tr>`)
    .join("");
  await send(
    `🟢 ${items.length} link(s) recovered — Web Site Auditor`,
    `<h2>${items.length} link(s) recovered</h2>
     <table border="1" cellpadding="6" cellspacing="0">
       <tr><th>Site</th><th>Exam</th><th>Type</th><th>URL</th></tr>${rows}
     </table>`,
  );
}

/** Weekly digest summarizing the audit run. */
export async function sendWeeklyDigest(html: string, totals: { checked: number; down: number; degraded: number }): Promise<void> {
  await send(
    `📊 Weekly audit — ${totals.down} down, ${totals.degraded} degraded of ${totals.checked}`,
    html,
  );
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
}
