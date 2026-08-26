import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const homepagePath = path.join(process.cwd(), "docs", "index.html");

async function readHomepage(): Promise<string> {
  return readFile(homepagePath, "utf8");
}

describe("Clawser website homepage", () => {
  it("presents the developer-tool positioning in English and Chinese", async () => {
    const html = await readHomepage();

    expect(html).toContain("Automate the browser you already use");
    expect(html).toContain("自动化你正在使用的浏览器");
    expect(html).toContain("127.0.0.1");
    expect(html).toContain("Chrome DevTools Protocol");
  });

  it("links to the project, support, and privacy destinations", async () => {
    const html = await readHomepage();

    expect(html).toContain("https://github.com/agilecho2022-lgtm/clawser");
    expect(html).toContain("https://github.com/agilecho2022-lgtm/clawser/issues");
    expect(html).toMatch(/href=["']privacy\.html["']/);
  });

  it("keeps the public copy aligned with the Edge review wording", async () => {
    const html = await readHomepage();
    const withoutProtocolName = html.replaceAll("Chrome DevTools Protocol", "");

    expect(withoutProtocolName).not.toMatch(/Chrome/i);
    expect(html).not.toMatch(/BillRPA/i);
    expect(html).not.toMatch(/collect(?:s|ed|ing)?\s+(?:any\s+)?data|data collection/i);
    expect(html).not.toMatch(/采集数据|收集数据|数据采集|数据收集/);
  });

  it("ships as a self-contained static page with accessible language controls", async () => {
    const html = await readHomepage();

    expect(html).toContain('data-language="en"');
    expect(html).toContain('data-language="zh"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/https?:\/\/[^"')]+\.(?:js|css)(?:[?"'])/i);
  });
});
