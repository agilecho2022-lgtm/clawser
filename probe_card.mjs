import { chromium } from "playwright";
const url = process.argv[2];
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_BROWSER_CHANNEL || "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const token = process.env.DSH_RIG_TOKEN ?? "";
if (token) await ctx.addInitScript((v) => window.localStorage.setItem("token", v), token);
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);
const out = await page.evaluate(() => {
  return [...document.querySelectorAll("article[data-business-card]")].map((card) => ({
    type: card.getAttribute("data-business-card"),
    label: card.getAttribute("aria-label"),
    text: (card.innerText || "").slice(0, 700),
    olItems: [...card.querySelectorAll("ol > li")].map((li) => li.innerText.trim()),
    blockKey: card.closest("section[data-timeline-block]")?.getAttribute("data-block-key") ?? "",
  }));
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
