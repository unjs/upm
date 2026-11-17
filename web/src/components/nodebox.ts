import { nodeboxHeight, nodeboxSrc } from "../lib/nodebox.ts";
import { currentScheme, onSchemeChange, type Scheme } from "../theme.ts";

const FRAME_TITLE = "Run this example in Nodebox";
const RUN_LABEL = "Run";

type Frame = {
  block: HTMLElement;
  button: HTMLButtonElement;
  code: string;
  iframe?: HTMLIFrameElement;
  scheme?: Scheme;
};

export function mountNodeboxes(root: HTMLElement): () => void {
  const frames = [...root.querySelectorAll<HTMLElement>("[data-nodebox]")].map(mountRunButton);
  if (frames.length === 0) return () => {};
  const unsubscribe = onSchemeChange(() => {
    for (const frame of frames)
      if (frame.iframe) void showFrame(frame, currentScheme(), { autorun: false });
  });
  return () => {
    unsubscribe();
    for (const frame of frames) unmount(frame);
  };
}

function mountRunButton(block: HTMLElement): Frame {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nodebox-run";
  button.textContent = RUN_LABEL;
  button.setAttribute("aria-label", FRAME_TITLE);
  const frame: Frame = { block, button, code: block.dataset.nodebox ?? "" };
  button.addEventListener(
    "click",
    () => void showFrame(frame, currentScheme(), { autorun: true }),
    { once: true },
  );
  block.append(button);
  return frame;
}

function unmount({ block, button, iframe }: Frame) {
  button.remove();
  iframe?.remove();
  block.style.removeProperty("height");
  delete block.dataset.loaded;
}

async function showFrame(frame: Frame, scheme: Scheme, { autorun }: { autorun: boolean }) {
  if (frame.iframe && frame.scheme === scheme) return;
  frame.scheme = scheme;
  const src = await nodeboxSrc(frame.code, scheme, { autorun });
  if (frame.scheme !== scheme) return;
  const iframe = frame.iframe ?? openFrame(frame);
  iframe.addEventListener("load", () => (frame.block.dataset.loaded = ""), { once: true });
  iframe.src = src;
}

function openFrame(frame: Frame): HTMLIFrameElement {
  frame.button.remove();
  frame.block.style.height = `${nodeboxHeight(frame.code)}px`;
  const iframe = document.createElement("iframe");
  iframe.title = FRAME_TITLE;
  iframe.allow = "clipboard-write";
  frame.block.append(iframe);
  frame.iframe = iframe;
  return iframe;
}
