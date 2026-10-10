import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_BROWSER_CHANNEL || "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const token = process.env.DSH_RIG_TOKEN ?? "";
if (token) await ctx.addInitScript((v) => window.localStorage.setItem("token", v), token);
const page = await ctx.newPage();
await page.goto(process.argv[2], { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(8000);
const byLabel = page.getByLabel("消息");                 // 与 testing-library getByLabelText 同一语义
const count = await byLabel.count();
const id = count ? await byLabel.first().getAttribute("id") : null;
const role = count ? await byLabel.first().evaluate((el) => el.tagName.toLowerCase()) : null;
console.log(JSON.stringify({ accessibleNameQueryMatches: count, matchedElement: role, id }, null, 1));
await browser.close();
