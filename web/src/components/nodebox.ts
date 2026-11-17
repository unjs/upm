import { nodeboxHeight, nodeboxSrc } from "../lib/nodebox.ts";
import { currentScheme, onSchemeChange, type Scheme } from "../theme.ts";

const FRAME_TITLE = "Run this example in Nodebox";

type Frame = {
  block: HTMLElement;
  code: string;
  iframe?: HTMLIFrameElement;
  scheme?: Scheme;
  disposed?: boolean;
};

export function mountNodeboxes(root: HTMLElement): () => void {
  const frames = [...root.querySelectorAll<HTMLElement>("[data-nodebox]")].map(reserveFrame);
  if (frames.length === 0) return () => {};
  const showAll = () => {
    for (const frame of frames) void showFrame(frame, currentScheme());
  };
  showAll();
  const unsubscribe = onSchemeChange(showAll);
  return () => {
    unsubscribe();
    for (const frame of frames) unmount(frame);
  };
}

function reserveFrame(block: HTMLElement): Frame {
  const code = block.dataset.nodebox ?? "";
  block.style.height = `${nodeboxHeight(code)}px`;
  block.dataset.open = "";
  return { block, code };
}

function unmount(frame: Frame) {
  frame.disposed = true;
  frame.iframe?.remove();
  frame.block.style.removeProperty("height");
  delete frame.block.dataset.open;
  delete frame.block.dataset.loaded;
}

async function showFrame(frame: Frame, scheme: Scheme) {
  if (frame.scheme === scheme) return;
  frame.scheme = scheme;
  const src = await nodeboxSrc(frame.code, scheme);
  if (frame.disposed || frame.scheme !== scheme) return;
  const iframe = frame.iframe ?? appendFrame(frame);
  iframe.addEventListener("load", () => (frame.block.dataset.loaded = ""), { once: true });
  iframe.src = src;
}

function appendFrame(frame: Frame): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.title = FRAME_TITLE;
  iframe.loading = "lazy";
  iframe.allow = "clipboard-write";
  frame.block.append(iframe);
  frame.iframe = iframe;
  return iframe;
}
