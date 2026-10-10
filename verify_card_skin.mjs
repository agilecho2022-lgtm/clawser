/**
 * Verify the in-card form controls match the composer's look (2026-09-12).
 *
 * Reads computed styles for every control inside the gate card and for the
 * composer textarea at the bottom, and reports the properties that define the
 * "refined" look (box radius, border, padding, font, focus ring).
 *
 * Usage: node verify_card_skin.mjs <url> [waitSeconds]
 */
import { chromium } from "playwright";

const url = process.argv[2];
const waitSeconds = Number(process.argv[3] ?? 8);

const browser = await chromium.launch({
  headless: true,
  channel: process.env.DSH_BROWSER_CHANNEL || "chrome",
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const token = process.env.DSH_RIG_TOKEN ?? "";
if (token) {
  await context.addInitScript((value) => window.localStorage.setItem("token", value), token);
}
const page = await context.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(waitSeconds * 1000);

const facts = await page.evaluate(() => {
  const pick = (el) => {
    const s = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") ?? "",
      radius: s.borderRadius,
      border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      padding: s.padding,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      width: Math.round(el.getBoundingClientRect().width),
    };
  };
  const card = document.querySelector("[data-business-card='gate']");
  const composer = document.querySelector("#dsh-message");
  const controls = card ? [...card.querySelectorAll("input, textarea, select")] : [];
  return {
    cardPresent: card !== null,
    cardTitle: card ? (card.querySelector("h3")?.textContent ?? "") : "",
    controls: controls.map(pick),
    composer: composer ? pick(composer) : null,
  };
});

const normalize = (v) => JSON.stringify(v);
const composer = facts.composer;
const mismatches = [];
if (composer) {
  for (const control of facts.controls) {
    if (control.type === "checkbox" || control.type === "radio") continue;
    for (const field of ["radius", "border", "padding", "fontSize", "lineHeight"]) {
      if (normalize(control[field]) !== normalize(composer[field])) {
        mismatches.push({ control: `${control.tag}[${control.type}]`, field, card: control[field], composer: composer[field] });
      }
    }
  }
}

console.log(JSON.stringify({ url, facts, mismatches }, null, 1));

if (facts.cardPresent) {
  await page.locator("[data-business-card='gate']").screenshot({ path: "/tmp/gate-card.png" });
  console.log("card screenshot: /tmp/gate-card.png");
}
await page.screenshot({ path: "/tmp/timeline-with-card.png" });
console.log("page screenshot: /tmp/timeline-with-card.png");
await browser.close();
