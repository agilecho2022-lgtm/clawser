/**
 * Gate-panel check for the "used gates must disappear" rule (2026-09-12).
 *
 * Reports what the timeline's "当前门控" area actually renders for the real
 * thread, so the rule can be verified against a gate that really was used
 * (M0.gate, status=succeeded, decision=approved).
 *
 * Usage: node check_gate_panel.mjs <url> [waitSeconds]
 */
import { chromium } from "playwright";

const url = process.argv[2];
const waitSeconds = Number(process.argv[3] ?? 8);

const browser = await chromium.launch({
  headless: true,
  channel: process.env.DSH_BROWSER_CHANNEL || "chrome",
});
const context = await browser.newContext();
const token = process.env.DSH_RIG_TOKEN ?? "";
if (token) {
  await context.addInitScript((value) => window.localStorage.setItem("token", value), token);
}
const page = await context.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(waitSeconds * 1000);

const facts = await page.evaluate(() => {
  const panel = document.querySelector("[data-gate-snapshot]");
  // Scope every text check to the gate area, so the same words appearing in the
  // agent's own messages or in narratives cannot be mistaken for the panel.
  const scope = panel ?? document.createElement("div");
  const scopeText = scope.innerText || "";
  const cardText = [...document.querySelectorAll("[data-business-card='gate']")]
    .map((e) => e.innerText)
    .join("\n");
  return {
    gateSnapshotSection: panel !== null,
    gateCards: document.querySelectorAll("[data-business-card='gate']").length,
    panelHasApprovedText: scopeText.includes("已通过"),
    panelHasEmptyNotice: scopeText.includes("暂无可显示的门控"),
    panelHasRefreshGate: scopeText.includes("刷新门控"),
    panelHasReasonBox: scopeText.includes("理由"),
    panelText: scopeText.slice(0, 200),
    cardHasApprovedText: cardText.includes("已通过"),
    cardText: cardText.slice(0, 200),
    alerts: [...document.querySelectorAll("[role=alert]")].map((e) => e.textContent.slice(0, 60)),
    blocks: document.querySelectorAll("[data-dsh-timeline] > *").length,
  };
});
console.log(JSON.stringify({ url, waitSeconds, facts }, null, 1));
await browser.close();
