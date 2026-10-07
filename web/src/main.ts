import { DOCS, isApp, pathOf } from "./lib/route.ts";
import { route } from "./router.ts";
import "./theme.ts";

// Safari's own pinch event, for the iOS versions that zoom past `touch-action` (src/style.css).
document.addEventListener("gesturestart", (e) => e.preventDefault());

const { pathname, search, hash } = location;
// Links from before the `/npm/` route.
const q = new URLSearchParams(search).get("q");
if (q) location.replace(pathOf(q.trim()));
else {
  // `/<spec>` is short for `/npm/<spec>`.
  if (pathname !== "/" && !isApp(pathname) && !DOCS.test(pathname)) {
    const spec = decodeURIComponent(pathname.slice(1)).replace(/\/$/, "");
    history.replaceState(null, "", pathOf(spec) + search + hash);
  }
  void route();
}
