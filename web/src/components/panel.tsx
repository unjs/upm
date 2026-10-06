// The bottom panel, below the editor and right of the sidebar: every registry request, what
// went wrong, and what this browser keeps on OPFS.
import { useRef, useState } from "react";
import type { RequestEntry } from "../lib/client.ts";
import { formatBytes } from "./code.tsx";
import { Storage } from "./storage.tsx";
import { clamp, Icon, IconButton, ISLAND, Sash, Tab, Tabs, useStored, Waiting } from "./ui.tsx";

export type PanelTab = "requests" | "problems" | "storage";

export interface Problem {
  level: "error" | "warning";
  source: string;
  message: string;
  error?: Error;
}

/** Stays mounted while closed (no `tab`), so it keeps the height it was dragged to. */
export function Panel(props: {
  tab: PanelTab | undefined;
  setTab: (tab: PanelTab) => void;
  onClose: () => void;
  requests: RequestEntry[];
  problems: Problem[];
  /** OPFS's size, which the Storage tab sets to its walked total. */
  opfs: number | undefined;
  setOpfs: (bytes: number) => void;
}) {
  const { tab, requests, problems, opfs } = props;
  const [height, setHeight] = useStored("panel-height", 240);
  const [maximized, setMaximized] = useState(false);
  const ref = useRef<HTMLElement>(null);
  if (!tab) return null;
  const tabs: [PanelTab, string, (number | string)?][] = [
    ["problems", "Problems", problems.length],
    ["requests", "Requests", requests.length],
    ["storage", "Storage", opfs === undefined ? undefined : shortBytes(opfs)],
  ];
  return (
    <section
      ref={ref}
      // Maximized, it takes all the height and shrinks only by what the content above can't give up.
      style={{ height: maximized ? "100%" : height }}
      className={`relative mt-3 flex flex-col pl-3 max-sm:pr-3 sm:pl-6 lg:pl-10 xl:pl-16 ${maximized ? "" : "max-h-[80%] shrink-0"}`}
    >
      <Sash
        vertical
        onDrag={(e) => {
          const bottom = ref.current?.getBoundingClientRect().bottom ?? innerHeight;
          setMaximized(false);
          setHeight(clamp(bottom - e.clientY, 80, innerHeight - 160));
        }}
      />
      <div className={`flex min-h-0 flex-1 flex-col ${ISLAND}`}>
        <div className="flex shrink-0 items-center gap-1 p-1.5">
          <Tabs>
            {tabs.map(([name, label, count]) => (
              <Tab key={name} active={tab === name} onClick={() => props.setTab(name)}>
                {label}
                {count !== undefined && (
                  <span className="rounded-full bg-zinc-200 px-1 text-[10px] leading-4 tabular-nums sm:px-1.5 dark:bg-zinc-700">
                    {count}
                  </span>
                )}
              </Tab>
            ))}
          </Tabs>
          <span className="ml-auto flex">
            <IconButton
              icon={maximized ? "restore" : "maximize"}
              title={maximized ? "Restore panel size" : "Maximize panel size"}
              onClick={() => setMaximized(!maximized)}
            />
            <IconButton icon="close" title="Close panel (Ctrl+`)" onClick={props.onClose} />
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto max-sm:pb-12">
          {tab === "requests" ? (
            <Requests requests={requests} />
          ) : tab === "storage" ? (
            <Storage onSize={props.setOpfs} />
          ) : (
            <Problems problems={problems} />
          )}
        </div>
      </div>
    </section>
  );
}

function Requests({ requests }: { requests: RequestEntry[] }) {
  if (requests.length === 0) return <Waiting>No requests yet.</Waiting>;
  // One time axis for all rows: from the first request to the last byte, or to now while one runs.
  const now = performance.now();
  const first = requests[0]!.start;
  const duration = (r: RequestEntry) => (r.done ? r.end : now - r.start);
  const last = requests.reduce((max, r) => Math.max(max, r.start + duration(r)), first);
  const span = Math.max(last - first, 1);
  const percent = (fraction: number) => `${fraction * 100}%`;
  return (
    <table className="w-full font-mono text-xs">
      <thead className="sticky top-0 z-10 bg-(--editor-bg)/85 backdrop-blur-xl text-left text-[10px] text-zinc-500">
        <tr>
          {/* As wide as the longest path, up to a cap; the waterfall takes the rest. */}
          <th className="w-px py-1 pr-3 pl-3 text-[11px] font-normal">path</th>
          <th className="pr-3 font-normal">
            <div className={`relative h-4 ${GRID}`}>
              {[0.25, 0.5, 0.75, 1].map((tick) => (
                <span
                  key={tick}
                  className="absolute top-0 pr-1 leading-4 tabular-nums"
                  style={{ right: percent(1 - tick) }}
                >
                  {formatMs(span * tick)}
                </span>
              ))}
            </div>
          </th>
        </tr>
      </thead>
      <tbody>
        {requests.map((r) => {
          const failed = r.status >= 400 || (r.done && !r.status);
          const total = duration(r);
          const from = (r.start - first) / span;
          const to = from + total / span;
          // Waiting for headers, then reading the body; all waiting until the headers land.
          const waiting = r.status ? Math.min(r.ms / Math.max(total, 1), 1) : 1;
          const info = [
            r.status || (r.done ? "failed" : "…"),
            formatBytes(r.bytes),
            r.done ? formatMs(total) : "…",
          ].join(" · ");
          // The info goes where it fits: after the bar, before it, or over it.
          const place =
            to <= 0.65
              ? { left: percent(to), className: "pl-1.5" }
              : from >= 0.35
                ? { right: percent(1 - from), className: "pr-1.5" }
                : {
                    left: percent(from),
                    className: "ml-1 rounded bg-(--editor-bg)/85 px-1 leading-3.5",
                  };
          return (
            <tr
              key={r.id}
              className="hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50"
              title={`#${r.id + 1} ${decode(r.url)}\nstart ${formatMs(r.start - first)}, headers ${r.status ? formatMs(r.ms) : "…"}, done ${r.done ? formatMs(total) : "…"}`}
            >
              <td className="py-0.5 pr-3 pl-3">
                <div className="max-w-[min(35vw,20rem)] truncate">
                  {decode(r.url.replace(/^https?:\/\/[^/]+/, ""))}
                </div>
              </td>
              <td className="pr-3">
                <div className={`relative h-4 ${GRID}`}>
                  <div
                    className={`absolute inset-y-[3px] flex min-w-0.5 overflow-hidden rounded-sm ${r.done ? "" : "animate-pulse"}`}
                    style={{ left: percent(from), width: percent(to - from) }}
                  >
                    <div
                      className={
                        failed ? "bg-red-300 dark:bg-red-900" : "bg-zinc-300 dark:bg-zinc-600"
                      }
                      style={{ width: percent(waiting) }}
                    />
                    <div className={`flex-1 ${failed ? "bg-red-500" : "bg-amber-500"}`} />
                  </div>
                  <span
                    className={`absolute inset-y-0 flex items-center text-[10px] whitespace-nowrap tabular-nums ${failed ? "text-red-600" : "text-zinc-500"}`}
                    style={{ left: place.left, right: place.right }}
                  >
                    <span className={place.className}>{info}</span>
                  </span>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Faint lines at each quarter of the time axis. */
const GRID =
  "bg-[linear-gradient(to_left,rgb(0_0_0/0.07)_1px,transparent_1px)] bg-size-[25%_100%] bg-right dark:bg-[linear-gradient(to_left,rgb(255_255_255/0.07)_1px,transparent_1px)]";

/** As read, `@scope/name` not `@scope%2fname`; a malformed escape stays as it is. */
function decode(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function Problems({ problems }: { problems: Problem[] }) {
  if (problems.length === 0) return <Waiting>No problems.</Waiting>;
  return (
    <ul className="py-1 text-xs">
      {problems.map((problem, i) => (
        <li key={i} className="flex gap-2 px-3 py-1">
          <Icon
            name={problem.level}
            className={`mt-px size-3.5 ${problem.level === "error" ? "text-red-500" : "text-amber-500"}`}
          />
          <div className="min-w-0 font-mono break-words">
            {problem.message}
            {problem.error && <Stack error={problem.error} />}
          </div>
          <span className="ml-auto shrink-0 text-zinc-400">{problem.source}</span>
        </li>
      ))}
    </ul>
  );
}

/** The frames only: V8 starts a stack with the message, which the line above already shows. */
function Stack({ error }: { error: Error }) {
  const stack = error.stack?.replace(`${error.name}: ${error.message}\n`, "").trimEnd();
  if (!stack || stack === `${error.name}: ${error.message}`) return null;
  return <pre className="mt-1 whitespace-pre-wrap text-zinc-500">{stack}</pre>;
}

/** A size short enough for a tab's badge: whole units from 10 up. */
function shortBytes(n: number): string {
  return formatBytes(n).replace(/^(\d{2,})\.\d/, "$1");
}
