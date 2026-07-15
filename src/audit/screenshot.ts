import { chromium, type Browser } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // Lean flags for a memory-constrained, shared box.
    browserPromise = chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--no-zygote",
      ],
    });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close().catch(() => undefined);
    browserPromise = null;
  }
}

export interface ShotResult {
  path: string | null;
  pngBase64: string | null;
  consoleErrors: string[];
  error?: string;
}

/** Render a URL and capture a full-page screenshot + console errors. */
export async function capture(url: string, fileBase: string): Promise<ShotResult> {
  const consoleErrors: string[] = [];
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err).slice(0, 300)));

    await page.goto(url, { waitUntil: "networkidle", timeout: env.tuning.httpTimeoutMs });

    await mkdir(env.tuning.screenshotDir, { recursive: true });
    const path = join(env.tuning.screenshotDir, `${fileBase}.png`);
    const buf = await page.screenshot({ path, fullPage: true });
    return { path, pngBase64: buf.toString("base64"), consoleErrors };
  } catch (err) {
    logger.warn({ err, url }, "screenshot capture failed");
    return { path: null, pngBase64: null, consoleErrors, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await context?.close().catch(() => undefined);
  }
}
