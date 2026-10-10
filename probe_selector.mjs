import { chromium } from "playwright";
const url = process.argv[2];
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_BROWSER_CHANNEL || "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const token = process.env.DSH_RIG_TOKEN ?? "";
if (token) await ctx.addInitScript((v) => window.localStorage.setItem("token", v), token);
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);
const out = await page.evaluate(() => {
  const cards = [...document.querySelectorAll("article[data-business-card]")];
  const last = cards[cards.length - 1];
  const inputs = last ? [...last.querySelectorAll("input,button,select,textarea")].map((el) => ({
    tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "", text: (el.textContent || "").trim().slice(0, 40),
    name: el.getAttribute("name") || el.id || "", checked: el.checked ?? null, disabled: el.disabled,
  })) : [];
  return {
    cardCount: cards.length,
    lastType: last?.getAttribute("data-business-card") ?? null,
    lastLabel: last?.getAttribute("aria-label") ?? null,
    lastText: last ? (last.innerText || "").slice(0, 1200) : null,
    controls: inputs.slice(0, 25),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
