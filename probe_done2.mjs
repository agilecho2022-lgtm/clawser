import { chromium } from "playwright";
const url = process.argv[2];
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_BROWSER_CHANNEL || "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const token = process.env.DSH_RIG_TOKEN ?? "";
if (token) await ctx.addInitScript((v) => window.localStorage.setItem("token", v), token);
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(10000);
const out = await page.evaluate(() => {
  const chain = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; i < 6 && node; i += 1) {
      const data = [...node.attributes].filter(a => a.name.startsWith("data-")).map(a => a.name).join("+");
      const cls = (node.className || "").toString().split(/\s+/).slice(0, 2).join(".");
      parts.push(`${node.tagName.toLowerCase()}${data ? `[${data}]` : ""}${cls ? "." + cls : ""}`);
      node = node.parentElement;
    }
    return parts;
  };
  const hits = [];
  const walk = (el) => {
    for (const child of el.children) {
      const own = [...child.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim();
      if (/\bdone\b/i.test(own) || own.includes("本轮完成")) {
        hits.push({ own: own.slice(0, 150), chain: chain(child), html: child.outerHTML.slice(0, 260) });
      }
      walk(child);
    }
  };
  walk(document.body);
  return hits;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
