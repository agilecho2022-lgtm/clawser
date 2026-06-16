import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

type ClickListener = () => void | Promise<void>;

type TestElement = {
  dataset: Record<string, string>;
  textContent: string;
  value: string;
  addEventListener: (event: string, listener: ClickListener) => void;
};

function createElement(): TestElement {
  return {
    dataset: {},
    textContent: "",
    value: "",
    addEventListener: () => {},
  };
}

function createOptionsDom() {
  const elements = new Map<string, TestElement>(
    ["relay-url", "status", "port", "save"].map((id) => [id, createElement()]),
  );
  let saveClick: ClickListener | null = null;
  const saveButton = elements.get("save");
  if (saveButton) {
    saveButton.addEventListener = (event, listener) => {
      if (event === "click") {
        saveClick = listener;
      }
    };
  }
  return {
    elements,
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
    },
    get saveClick() {
      return saveClick;
    },
  };
}

async function importOptionsPage(): Promise<void> {
  const assetPath = resolve(process.cwd(), "assets/chrome-extension/options.js");
  const optionsPath = existsSync(assetPath)
    ? assetPath
    : resolve(process.cwd(), "chrome-extension/options.js");
  const url = pathToFileURL(optionsPath);
  url.searchParams.set("testRun", `${Date.now()}-${Math.random()}`);
  await import(url.href);
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chrome extension options page", () => {
  it("checks relay reachability on load without a gateway token", async () => {
    const dom = createOptionsDom();
    const sendMessage = vi.fn(async () => ({
      contentType: "application/json",
      json: { connected: false },
      ok: true,
      status: 200,
    }));
    vi.stubGlobal("document", dom.document);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: {
        local: {
          get: vi.fn(async () => ({ relayPort: "not-a-port" })),
          set: vi.fn(),
        },
      },
    });

    await importOptionsPage();
    await flushAsyncWork();

    expect(dom.elements.get("port")?.value).toBe("18792");
    expect(dom.elements.get("relay-url")?.textContent).toBe("http://127.0.0.1:18792/");
    expect(sendMessage).toHaveBeenCalledWith({
      type: "relayCheck",
      url: "http://127.0.0.1:18792/extension/status",
    });
    expect(dom.elements.get("status")?.dataset.kind).toBe("ok");
    expect(dom.elements.get("status")?.textContent).toBe(
      "Relay reachable at http://127.0.0.1:18792/",
    );
  });

  it("saves the relay port and validates it without a token", async () => {
    const dom = createOptionsDom();
    const set = vi.fn(async () => {});
    const sendMessage = vi.fn(async () => ({
      contentType: "application/json",
      json: { connected: false },
      ok: true,
      status: 200,
    }));
    vi.stubGlobal("document", dom.document);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: {
        local: {
          get: vi.fn(async () => ({ relayPort: 18792 })),
          set,
        },
      },
    });

    await importOptionsPage();
    await flushAsyncWork();
    sendMessage.mockClear();

    const portInput = dom.elements.get("port");
    expect(portInput).toBeDefined();
    if (!portInput || !dom.saveClick) {
      throw new Error("options page test DOM was not initialized");
    }
    portInput.value = "19004";
    await dom.saveClick();
    await flushAsyncWork();

    expect(set).toHaveBeenCalledWith({ relayPort: 19004 });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "relayCheck",
      url: "http://127.0.0.1:19004/extension/status",
    });
    expect(dom.elements.get("status")?.dataset.kind).toBe("ok");
    expect(dom.elements.get("status")?.textContent).toBe(
      "Relay reachable at http://127.0.0.1:19004/",
    );
  });
});
