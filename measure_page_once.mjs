/**
 * Robust single-read page probe.
 *
 * The interactive probe loop in measure_timeline_page.mjs cannot report a page
 * whose main thread is frozen for a minute: every probe evaluate blocks behind
 * the freeze. Long tasks are recorded by a buffered PerformanceObserver inside
 * the page, so a *single* evaluate at the end still returns the whole picture —
 * it just waits until the main thread is free again.
 *
 * Usage: node measure_page_once.mjs <url> <waitSeconds>
 */
import { chromium } from "playwright";

const url = process.argv[2];
const waitSeconds = Number(process.argv[3] ?? 60);

const browser = await chromium.launch({
  headless: true,
  channel: process.env.DSH_BROWSER_CHANNEL || "chrome",
});
const context = await browser.newContext();
const token = process.env.DSH_RIG_TOKEN ?? "";
if (token) {
  await context.addInitScript((value) => window.localStorage.setItem("token", value), token);
}
const page = await context.newPage();
await page.addInitScript(() => {
  window.__longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__longTasks.push({ start: Math.round(entry.startTime), dur: Math.round(entry.duration) });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch (error) {
    window.__longTasksError = String(error);
  }
});

const started = Date.now();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
// Wait outside the page: no evaluate, so a frozen main thread cannot stall us.
await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

const wallBeforeProbe = Date.now() - started;
page.setDefaultTimeout(180_000);
let summary = null;
let probeError = null;
try {
  summary = await page.evaluate(async () => {
    const tasks = window.__longTasks ?? [];
    const nav = performance.getEntriesByType("navigation")[0] ?? {};
    const feed = document.querySelector("[data-dsh-timeline]");
    return {
      longTaskCount: tasks.length,
      longTaskTotalMS: tasks.reduce((sum, t) => sum + t.dur, 0),
      longTaskMaxMS: tasks.reduce((max, t) => Math.max(max, t.dur), 0),
      firstLongTaskStartMS: tasks.length ? tasks[0].start : null,
      domContentLoadedMS: Math.round(nav.domContentLoadedEventEnd ?? 0),
      loadEventMS: Math.round(nav.loadEventEnd ?? 0),
      blocks: feed ? feed.children.length : -1,
      alerts: [...document.querySelectorAll("[role=alert]")].map((e) => e.textContent.slice(0, 80)),
      probeResponsive: await new Promise((resolve) => {
        const t0 = performance.now();
        setTimeout(() => resolve(Math.round(performance.now() - t0)), 0);
      }),
    };
  });
} catch (error) {
  probeError = String(error).slice(0, 200);
}

console.log(JSON.stringify({
  url,
  waitSeconds,
  wallBeforeProbeMS: wallBeforeProbe,
  totalWallMS: Date.now() - started,
  summary,
  probeError,
}, null, 1));

await browser.close();
