import { getPageForTargetId } from "./pw-session.js";

export type BrowserFrameHTML = {
  index: number;
  name: string;
  url: string;
  parentIndex: number | null;
  html: string;
};

export async function dumpFramesHTMLViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ frames: BrowserFrameHTML[] }> {
  const page = await getPageForTargetId(opts);
  const frames = page.frames();
  const indexByFrame = new Map<unknown, number>();
  frames.forEach((frame, index) => {
    indexByFrame.set(frame, index);
  });

  const captured = await Promise.all(
    frames.map(async (frame, index) => {
      const parentFrame = frame.parentFrame();
      return {
        index,
        name: frame.name(),
        url: frame.url(),
        parentIndex: parentFrame ? (indexByFrame.get(parentFrame) ?? null) : null,
        html: await frame.evaluate(() => document.documentElement.outerHTML),
      };
    }),
  );
  return { frames: captured };
}
