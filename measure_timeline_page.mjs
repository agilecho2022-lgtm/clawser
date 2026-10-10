/**
 * dsh/timeline hang measurement (UI-500-TRIAGE follow-up).
 *
 * Loads the real local thread page in a headless Chromium, records:
 *   - console errors / page errors,
 *   - long-task count + total/max blocking time (PerformanceObserver, buffered),
 *   - when the timeline feed first has content and how many records it renders,
 *   - main-thread responsiveness probes (setTimeout round-trip) over time.
 *
 * Usage: node measure_timeline_page.mjs <url> [seconds]
 */
import { chromium } from "playwright";

const url = process.argv[2];
const seconds = Number(process.argv[3] ?? 30);
if (!url) {
  console.error("usage: node measure_timeline_page.mjs <url> [seconds]");
  process.exit(2);
}

const channel = process.env.DSH_BROWSER_CHANNEL || "chrome";
const browser = await chromium.launch({ headless: true, channel });
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200));
});
page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));

// Seed the login token (the rig's frontend reads localStorage.token) before the
// app boots, exactly like a logged-in operator session.
const token = process.env.DSH_RIG_TOKEN ?? "";
if (token) {
  await context.addInitScript((value) => {
    window.localStorage.setItem("token", value);
  }, token);
}

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

const samples = [];
const probe = async () => {
  const at = Date.now() - started;
  let responsive = null;
  const probeStart = Date.now();
  try {
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    responsive = Date.now() - probeStart;
  } catch (error) {
    responsive = `ERR ${String(error).slice(0, 60)}`;
  }
  let blocks = null;
  try {
    blocks = await page.evaluate(
      () => document.querySelectorAll("[data-dsh-timeline] > *").length,
    );
  } catch (error) {
    blocks = `ERR ${String(error).slice(0, 40)}`;
  }
  samples.push({ at, blocks, responsiveMS: responsive });
};

const deadline = started + seconds * 1000;
while (Date.now() < deadline) {
  await probe();
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

const summary = await page.evaluate(() => {
  const tasks = window.__longTasks ?? [];
  const nav = performance.getEntriesByType("navigation")[0] ?? {};
  return {
    longTaskCount: tasks.length,
    longTaskTotalMS: tasks.reduce((sum, t) => sum + t.dur, 0),
    longTaskMaxMS: tasks.reduce((max, t) => Math.max(max, t.dur), 0),
    firstLongTaskStartMS: tasks.length ? tasks[0].start : null,
    domContentLoadedMS: Math.round(nav.domContentLoadedEventEnd ?? 0),
    loadEventMS: Math.round(nav.loadEventEnd ?? 0),
    blocks: document.querySelectorAll("[data-dsh-timeline] > *").length,
    alerts: [...document.querySelectorAll("[role=alert]")].map((e) => e.textContent.slice(0, 80)),
  };
});

console.log(JSON.stringify({
  url,
  seconds,
  summary,
  samples,
  consoleErrors: consoleErrors.slice(0, 10),
  pageErrors: pageErrors.slice(0, 10),
}, null, 1));

await browser.close();
