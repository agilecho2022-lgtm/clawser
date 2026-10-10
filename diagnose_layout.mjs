/**
 * Timeline layout diagnostics (2026-09-12).
 *
 *   node diagnose_layout.mjs <url> [waitSeconds]
 *
 * Reports, for the real page:
 *   - horizontal overflow: every element whose content is wider than its own
 *     box, plus the scroll region's own client/scroll widths;
 *   - every input/textarea/select with its classes + computed border/padding,
 *     so an unstyled control next to the polished composer is obvious;
 *   - a full-page screenshot path for visual confirmation.
 */
import { chromium } from "playwright";

const url = process.argv[2];
const waitSeconds = Number(process.argv[3] ?? 8);
const shot = process.argv[4] ?? "/tmp/timeline-layout.png";

const browser = await chromium.launch({
  headless: true,
  channel: process.env.DSH_BROWSER_CHANNEL || "chrome",
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const token = process.env.DSH_RIG_TOKEN ?? "";
if (token) {
  await context.addInitScript((value) => window.localStorage.setItem("token", value), token);
}
const page = await context.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(waitSeconds * 1000);

const report = await page.evaluate(() => {
  const describe = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().slice(0, 110),
      data: [...el.attributes]
        .filter((a) => a.name.startsWith("data-"))
        .map((a) => a.name)
        .join(","),
      w: Math.round(rect.width),
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
      text: (el.textContent || "").trim().slice(0, 50),
    };
  };

  const region = document.querySelector("[data-dsh-log-region]");
  const overflowers = [];
  if (region) {
    for (const el of region.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      if (style.display === "none") continue;
      // Element's own scrollable content, plus elements sticking out of the
      // region's content box.
      const rect = el.getBoundingClientRect();
      const regionRect = region.getBoundingClientRect();
      const sticksOut = rect.right > regionRect.right + 1 || rect.left < regionRect.left - 1;
      if (el.scrollWidth > el.clientWidth + 1 || sticksOut) {
        overflowers.push(describe(el));
      }
      if (overflowers.length >= 25) break;
    }
  }

  const controls = [...document.querySelectorAll("input, textarea, select")].map((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") ?? "",
      label: (() => {
        const wrap = el.closest("label");
        return wrap ? (wrap.textContent || "").trim().slice(0, 24) : "";
      })(),
      cls: (el.className || "").toString().slice(0, 80),
      placeholder: el.getAttribute("placeholder") ?? "",
      rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
      border: `${style.borderWidth} ${style.borderStyle} ${style.borderColor}`,
      radius: style.borderRadius,
      padding: style.padding,
      background: style.backgroundColor,
      outline: style.outlineWidth,
    };
  });

  return {
    region: region ? describe(region) : null,
    bodyScroll: {
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
    },
    overflowers,
    controls,
  };
});

console.log(JSON.stringify({ url, report }, null, 1));
await page.screenshot({ path: shot, fullPage: false });
console.log("screenshot:", shot);
await browser.close();
