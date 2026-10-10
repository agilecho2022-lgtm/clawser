import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_BROWSER_CHANNEL || "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:3080/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(4000);
const out = await page.evaluate(() => {
  const pick = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().slice(0, 200),
      data: [...el.attributes].filter(a => a.name.startsWith("data-")).map(a => a.name).join("+"),
      size: { w: Math.round(r.width), h: Math.round(r.height) },
      radius: s.borderRadius,
      border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      padding: s.padding,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      background: s.backgroundColor,
      color: s.color,
      boxShadow: s.boxShadow === "none" ? "none" : s.boxShadow.slice(0, 80),
      fontFamily: s.fontFamily.slice(0, 40),
      outline: s.outlineWidth,
      resize: s.resize,
    };
  };
  const candidates = [...document.querySelectorAll("textarea, [contenteditable='true'], input[type=text], form")];
  return {
    title: document.title,
    url: location.href,
    bodyText: document.body.innerText.slice(0, 160),
    candidates: candidates.slice(0, 6).map(pick),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
