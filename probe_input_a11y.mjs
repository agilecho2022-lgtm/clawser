import { chromium } from "playwright";
const url = process.argv[2];
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_BROWSER_CHANNEL || "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const token = process.env.DSH_RIG_TOKEN ?? "";
if (token) await ctx.addInitScript((v) => window.localStorage.setItem("token", v), token);
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(8000);
const out = await page.evaluate(() => {
  const ta = document.querySelector("#dsh-message");
  const wrap = ta?.parentElement;                    // 表单
  const card = wrap?.parentElement;                  // 输入卡 div
  const region = card?.parentElement;                // section[data-dsh-input-region]
  const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; };
  const cs = (el) => { const s = getComputedStyle(el); return { padding: s.padding, border: `${s.borderTopWidth} ${s.borderTopStyle}`, background: s.backgroundColor }; };
  return {
    textarea: { rect: rect(ta), style: cs(ta), ariaLabel: ta.getAttribute("aria-label"), labelledby: ta.getAttribute("aria-labelledby"), minHeight: getComputedStyle(ta).minHeight },
    form: { rect: rect(wrap), style: cs(wrap) },
    card: { rect: rect(card), style: cs(card), cls: card.className },
    region: { rect: rect(region), style: cs(region), ariaLabel: region.getAttribute("aria-label"), cls: region.className },
    labelCount: document.querySelectorAll("label[for='dsh-message']").length,
    visibleText: (region.innerText || "").trim().slice(0, 40),
  };
});
console.log(JSON.stringify(out, null, 1));
await page.screenshot({ path: process.argv[3] || "/tmp/input-before.png" });
await browser.close();
