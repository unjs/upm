// Worker entry for the registry pool. It runs an ordinary `createRegistry` on another core and
// answers one manifest per question, so the sockets, the inflate, the decode and the pluck of a
// packument are off the thread that walks the tree. Only the manifest crosses the port: a whole
// document cloned back can cost the receiver as much as parsing it. See .agents/perf.md.
import { builtin } from "./builtin.ts";
import { cacheLookups } from "./dns.ts";
import { createDocumentCache } from "./metadata.ts";
import { createRegistry } from "./registry.ts";
import type { Registry } from "./registry.ts";
import type { Answer, Asked, Question, WorkerData } from "./registry-pool.ts";
import type { Manifest } from "./types.ts";

async function answer(registry: Registry, q: Asked): Promise<Manifest | undefined> {
  if (q.op === "pinned") return await registry.pinned(q.name, q.version);
  if (q.op === "manifest") return await registry.manifest(q.name, q.version);
  return await registry.pick!(q.spec, q.pinned, q.options);
}

const port = builtin.workers.parentPort;
if (port) {
  const data = builtin.workers.workerData as WorkerData;
  const cache = data.metadata && createDocumentCache(data.metadata);
  const registry = createRegistry({ ...data, cache });
  port.on("message", (question: Question) => {
    void answer(registry, question).then(
      (found) => port.postMessage({ id: question.id, found } satisfies Answer),
      (error: unknown) => {
        const { message, code, status } = error as {
          message?: string;
          code?: string;
          status?: number;
        };
        const failed = { message: String(message ?? error), code, status };
        port.postMessage({ id: question.id, failed } satisfies Answer);
      },
    );
  });
  // The first `fetch()` in a fresh isolate costs ~40 ms more than the second: the web fetch
  // machinery loads on first use. Setting up the dispatcher loads the half of it that can be
  // loaded without a request, so the first question is not the one that pays (~25 ms).
  void (cacheLookups() ?? Promise.resolve()).then(() =>
    port.postMessage({ id: -1 } satisfies Answer),
  );
}
