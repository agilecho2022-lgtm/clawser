import { chromium } from "playwright";
const url = process.argv[2];
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_BROWSER_CHANNEL || "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const token = process.env.DSH_RIG_TOKEN ?? "";
if (token) await ctx.addInitScript((v) => window.localStorage.setItem("token", v), token);
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);
const out = await page.evaluate(() => {
  const chain = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; i < 6 && node; i += 1) {
      const cls = (node.className || "").toString().slice(0, 60);
      const data = [...node.attributes].filter(a => a.name.startsWith("data-")).map(a => a.name).join("+");
      parts.push(`${node.tagName.toLowerCase()}${data ? `[${data}]` : ""}${cls ? `.${cls.replace(/\s+/g, ".")}` : ""}`);
      node = node.parentElement;
    }
    return parts;
  };
  return [...document.querySelectorAll("pre")].map((el) => ({
    overflow: el.scrollWidth > el.clientWidth + 1,
    scrollW: el.scrollWidth, clientW: el.clientWidth,
    cls: (el.className || "").toString(),
    text: (el.textContent || "").trim().slice(0, 60),
    chain: chain(el).slice(0, 4),
  })).filter((p) => p.overflow);
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
