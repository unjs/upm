# Design constraints

These explain what a change must preserve and why. Read source for the mechanism;
read [status.md](status.md) for limits that still need work.

## Lockfiles must travel

A lockfile belongs to the project, not to the machine or registry that created it.
Keep all platforms' optional builds until install time. Otherwise frozen installs
can silently lose a native dependency on another machine. Missing metadata is not
permission to infer platform restrictions from a package's name.

Changing mirrors must not change package identity when integrity is unchanged.
Keep nonstandard tarball URLs intact: only the conventional registry URL is portable
by derivation. Integrity identifies bytes; a URL identifies where to request them.
But a lockfile's integrity is the lockfile's word too, so a registry package whose url is not on
its registry on the installing machine (by host, `onRegistry` in `src/lock.ts`) is held to the
integrity its scope's registry publishes for that name and version before any byte from there,
or from the store, is used (`src/mirror.ts`): otherwise that server decides both the bytes and
the name inside them. npmjs counts only for a name the default registry serves, since a scope
sent elsewhere may be anyone's there. On its registry, a url in the registry's
`…/<name>/-/<file>` layout is held the same way unless it names that package and version: a
registry serves anyone's tarball there, and a tarball may say it is any package.
A kept document answers, so only such entries ever ask, and offline without one they are
refused. A registry that publishes only a sha1 `shasum` passes only a lockfile naming that
sha1, which the tarball is then checked against: forging bytes to an existing sha1 is a second
preimage, which SHA-1 still resists.
A scope's registry is derived the same way, from the installing machine's `.npmrc`,
so a private registry serving the conventional url stays out of the lockfile.

Credentials belong to a `//host/path/`, never to a package. They go with every request
under that url, with the rest of that host as npm allows, and with nothing else,
including where a redirect leads. A credential with no url is refused rather than sent
to whichever registry a project's `.npmrc` names. The registry threads get the same map
the main thread has; nothing else may carry it.

Resolved edges let a frozen install work without version selection or metadata
requests. Preserve that property when changing the format. Dependency-group and
peer information must also survive: production, optional failure handling and peer
rebinding cannot be reconstructed from versions alone.

Another manager's lockfile is read, never written, and no `upm.lock` appears beside it.
A command that would change the tree there is refused: writing the choice anywhere else
would leave two lockfiles that disagree. What such a file cannot say is taken from the
tarball, never guessed; what it holds that upm cannot install is refused, not dropped.
Its root pins are held to package.json as `upm.lock`'s are (`sameTree`), an override's value
included, before anything is fetched: it is as easy to edit, and a pin to another package is
the one edge no package.json at link time would refuse.

## A workspace is a leaf, never a store entry

A workspace's identity is `name@link:<path>`, so it can never collide with a registry
`name@version` in the lockfile, the store or a consumer's key. In its consumer's key it
is a leaf: its own dependencies never move a consumer's store entry, only the links in
the workspace's own `node_modules`. Edges to a workspace come from the root or another
workspace only. A `.upm` entry never links to one, which is what keeps `.upm`
self-contained and portable across projects; keep that even where npm would link the
workspace into a registry package. The root's `.npmrc` is the only one read, or two
workspaces could install one lockfile two ways.

## A `link:` directory is the project's, not the store's

A `link:<path>` dependency is a local record like a workspace (`name@link:<path>`, linked
from its directory) but never a top: nothing it declares is walked, no `node_modules` is
made in it, and its path may climb out of the project. `upm.lock` keeps only the top's edge,
as pnpm's does, and accepts a `link:` edge to no workspace only where that top's own spec is
`link:`, so a hand-edited lockfile cannot point a registry range at a directory. Its bins
and version are read off its `package.json` at install time (`readLinks`), never locked.

## A tarball is keyed by where it is

A tarball dependency's identity is `name@<source>`: its http(s) url, or `file:` and a
root-relative `/` path. Like a workspace's `link:`, it never shares a key with a registry
`name@version`, while the store names its entry by the version inside, so the source is never
a path segment. A path is relative and from a top only: an absolute one would not travel with
the lockfile, and a registry package's directory is nowhere in the tree. Only such a source
is ever read off the disk (`Tarball` in `src/store.ts`): a url a registry sends, `file:` or
not, is always a url. The bytes are read when the source is first locked, and stored under
their own sha512.

A url is then pinned, as a registry tarball is: the lockfile's integrity decides, and other
bytes there fail the install instead of changing the tree quietly. A local tarball is the
project's own file, read like package.json: the lockfile holds only while each is the file
it pinned, so an install checks each (its stamp, then its hash when the stamp moved), locks one
whose bytes moved anew and keeps the rest of the tree, and a frozen install calls the lockfile
stale. The state records each tarball's stamp from just before its bytes were checked or read,
never after, so a write that lands during an install shows as another stamp next time; the
no-op check trusts nothing it has no stamp for. A stamp proves the file unchanged, not which
bytes the lockfile names, so it is kept with the integrity it was checked against and trusted
only while the lockfile pins that one; any other is hashed, since the store may hold its bytes.

A url has no name to hold its bytes to, and the store is keyed by integrity alone, so an index
lists the urls its tarball was fetched from, and a url's entry is filled and linked only from
one that lists that url (`vouched` in `src/store.ts`); any other is asked of the url, checked,
and the url listed. An index from before the list costs that url one request, and fails
offline. Without this, a lockfile could give a url any tarball in the store.

## Stability is not freshness

An unrelated manifest edit should not upgrade the rest of the tree. But a reused
plugin must see the current host, not a peer binding copied from an older tree.
Check both version stability and peer rebinding when changing lock reuse.

The overrides a lockfile was made under are in it (`root.overrides`, normalized), so a
changed rule makes it stale. A locked entry replays exact versions and no ranges, so one with
an edge to a name whose rule changed is walked again from its manifest at its locked version,
not replayed; one whose `-` went could have any edge back, so then every entry is.

Do not equate an early resolver pick with a final dependency. Optional failures and
peer settling can remove it. Prefetch may fill the cache, but must not decide what
is linked or turn an optional failure into a required one.

## Cached state is evidence, not authority

A fast no-op check is not a content audit. Keep that distinction visible to callers;
do not claim byte verification from a size check.

The install state carries two levels of evidence. Its `hash` describes the resolution and is
compared with one computed from the lockfile; its `inputs` describe what that resolution was
computed from (lockfile bytes, root manifest, each workspace's path and manifest,
`pnpm-workspace.yaml` when it holds overrides, store, registry hosts, platform, flags), and an install whose inputs match checks only what the state
recorded — the links and bins of the root and of each workspace, the package dir each direct
link lands on, the `.upm` entry names — without reading the graph. It costs a stat per direct
dependency, never one per package; damage deeper in an entry is `--verify`'s to find. Both
trust the state's `entries`, `root` and `tops` for _which_ names to look for; neither reads a
file's bytes. Anything that changes what a resolution is a function of (a new `.npmrc` key
that changes hosts, say) must be added to the inputs (`inputsOf` in `src/api.ts`), or the
short check lies.

Which workspaces there are is an input too, and globbing for them was most of a no-op install
in a big monorepo. The state keeps a proof of the set (`listWorkspaces` in
`src/workspaces.ts`): the names in each folder the glob could list, and which folders hold a
package.json. A folder whose stamp moved is read again, and only other names, or a package.json
come or gone, send the install back to the glob; the folder's own `node_modules`, where the
install writes, is not among them. A link is walked into whatever it leads to, nothing or a file
included, since either may become a folder; under `**`, with no depth to stop at, a link means
no proof. A stamp stands in for a read only once it is older than a timestamp's tick can hide,
so a change in the same tick as the recording is still seen, and it is taken before the read
it stands for. A proof is kept only when the glob found what the folders read just before it
imply; `--verify` never uses one.

The tree also keeps a copy of the lockfile it was last linked from (`node_modules/.upm.lock`).
With no lockfile, an install writes it back only when it still describes package.json, as
`sameTree` decides for any lockfile; a copy that does not is ignored, never used to keep
versions, so a changed package.json still resolves as if there were no tree. The copy is a
lockfile, not proof of the tree: the state still decides what is on disk. A frozen install
never reads it, and a tree another manager's lockfile changed keeps none.

`sameTree` also holds each top's pins to the ranges it declares, or to the value of an override
that reaches the edge, so a lockfile edited to pin another version under the same range is stale. An install that resolves writes `upm.lock`
before the fill, so the link can run under it, and puts back what was there when the install
fails: its integrities came from metadata, and no tarball proved them. A lockfile another
install wrote since stays. `lock` writes from metadata alone.

Another command may write `upm.lock` or package.json while an install runs, so the state
names the lockfile bytes the install planned from, never the file's by the end, and keeps
the two files' stamps only when each, stamped before it is read again, still holds what the
install used. `add` and `remove` write package.json only if it is still the text they read,
checked and renamed under `.upm.editing` beside it; otherwise the edit is made again from the
file as it is now, so two at once keep both edits. An editor's write takes no hold.

Shared hardlinks make writes affect other projects. Treat installed content as
immutable. Integrity must pass before untrusted archive content is written to the
shared store, and an index must not expose an unfinished package. Content becomes
addressable — a blob name, an index — only after the tarball's integrity has passed;
before that, bytes may exist only in a private temp file (`files/<pid>-*.tmp`, mode
0600, no blob name), removed when the tarball fails and swept by `prune` once its
process is dead and the grace period is over.

A declared bin's CRLF shebang loses only its terminating CR. The tarball keeps its
published integrity; each stored file's hash and size describe the normalized bytes.

The store is keyed by integrity alone, so integrity proves bytes, not which package they
are. An index keeps the name and version its tarball's package.json claims, and a registry
package is linked only when they are its own, spelled exactly: an alias's are the package
its lock entry names. Nothing in upm.lock is trusted for that name. The root's and each
workspace's package.json say what their own edges are (`sameTree`): an alias's package, a
tarball's source, a workspace for a workspace spec. Each package's own package.json says what
its edges are: the index keeps what it installs under another name or from a url, and an entry
is linked only when every edge lands on what it declares (`misdeclared`), whatever the lock
calls a peer. A peer settles on whatever the tree holds under its name, so it may land on an
alias or a tarball only where the root's or a workspace's own edge put one, or a package's own
edge that the tops reach through edges each package.json declares: a lock can add an edge no
package.json names, and nothing else holds one to it. Nor can it make an edge a peer: a peer
on an alias or a tarball must be one its dependent's package.json declares and does not also
depend on. An older lock that names an alias only by its url is read as that alias, since
nothing takes the url's word for it either. Without all this, a lockfile could give one
package another's tarball.

A store backend (`src/store-backend.ts`) is the one exception, and it is trusted as the store
is: without the tarball nothing can check a package's file list against its integrity, so
whoever can write to the backend decides what a package holds. A blob is still checked against
its hash, unless the backend says it is `trusted`, and an index from it passes the tar
reader's path rules before anything is written. It is asked only on a miss, never on the
warm path, and a failure or silence from it is a miss, reported once through `log`.

Publish complete package entries, not partially built directories. This is not a
transaction over the whole install. On failure, state must not certify an incomplete
tree, and retry must remain possible. Do not clean up a worker's destination while
another worker can still write into it. Grace periods reduce races; they do not
prove concurrent deletion safe.

Nothing is fsynced: syncing every blob costs seconds on a cold install, and syncing only
the index would make an index over lost bytes more likely, not less. Power loss can leave
an index over short blobs. Linking heals that: an entry whose files are short, over blobs
that are short too, throws ELINK, and the install refills the store with sizes checked.

An index's mtime is evidence too: `--verify` hashes only the blobs newer than it (`sound` in
`src/verify.ts`). So an index written again over the same tarball — one from before it kept
aliases, written back once a link has read them (`src/index-upgrade.ts`) — keeps its old mtime,
and is renamed in whole, so a concurrent reader sees either the old one or the new.

A dropped optional is the one kind of short tree that state may certify, and it names what
is `missing`. That applies only when asking again would not help: the tarball is gone (404),
its bytes are not the pinned ones or not a tarball, it is another package's, or it failed
again on the next install's one retry. Anything else leaves the tree incomplete, and the
next install fills it again. Only `--verify` or a new resolution asks about a certified one
again.

One install at a time rewrites a tree. `node_modules/.upm.linking` is taken with an exclusive
create once the link finds the tree must change, never on the no-op path. Its holder touches it
every 2 s, and gives it up before a signal or an exit ends it. A signal is re-raised only when
upm alone listens for it: an app that listens decides whether the process ends. A waiter takes
it over when its pid is gone and it names this boot and pid namespace (Linux) or this host and
boot second (macOS, Windows), when it is untouched for 10 s and its pid is gone, or for a minute
whatever the pid says, since a pid from another namespace proves nothing. Only the waiter that
creates `<file>.taking` removes a dead file, and only while it is still the one it judged: two
that remove the same dead file would let two installs hold it. The store has no lock: an
install that loses content to a prune fails its link and refills.

## Optimization must keep the same answer

Metadata parsing shortcuts must select the real registry member, never a lookalike
nested in publisher-controlled data. Use full parsing when the shortcut is unsure.
Test hostile documents as well as normal registry output. A kept document's index is
believed about a version it lacks, not only where one sits, so it is only ever written by the
structural scan of the same bytes, in the same file. A big one is read in parts, its body
only where a pick reads, and only while the file is still the one its head came from (device,
inode and size): once it is not, the name is read afresh (`ECHANGED`), never at the old
offsets. Those three cannot see a file rewritten in place at its size, which upm never does
but for the date in its head, so a manifest read so must also be the version asked for.

Threads are an optional execution strategy, not a different resolver or installer.
Keep local and pooled results equivalent, including failure and shutdown behavior.
Bound memory as well as job counts: moving download completion ahead of unpack can
turn a concurrency change into an unbounded queue of archive bytes. A download slot ends at
the last byte, so the bytes past it have a bound of their own (`held` in `src/store.ts`),
asked with the slot in hand and kept out of the slot's latency sample. Each pool is closed
by the phase that used it; only the bin exits the process, and only after its output is
out and a failed write has set the exit code. Through the library nothing exits: an
idle thread is unref'd. A one-package install must not boot a thread it will not use.
So the registry threads start after a few distinct names (`START_AT` in `src/registry-pool.ts`),
not at pool creation, and a name whose thread is still booting waits for it instead of being
asked on the main thread: on a big tree the two starts are equivalent, and creation start costs
a one-package install most of its time. They start at creation only when the caller already
knows that many names will be asked (`expected`): a resolve that has no lockfile to skip it, of
a root that declares that many or has workspaces. A pool opened that early is closed by the
command that opened it when its resolve never comes. Measure `tiny` as well as the big fixtures
when changing when a thread starts.

A worker is bundled whole into the chunk of the pool that starts it and started from a `data:`
URL (`src/workers.ts`, `build.config.ts`). An app that bundles upm copies no file of ours and
may not keep `import.meta.url`, so a worker imports nothing at runtime but builtins, and the
built pools never read `import.meta.url`. A pool that starts no thread at all says so once,
through the caller's `log`: a quiet fallback made a bundled install 2.3× slower unnoticed.

Address lookups are cached in an undici agent of upm's own that travels with each registry
request (`fetching()` in `src/dns.ts`) and each tarball download (`getter()`, the agent's own
callbacks without `fetch`'s objects). That download follows a redirect as `fetch` does and keeps
its rule: a credential goes no further than the origin it was sent to. The process's global
dispatcher is never written: a host that calls into upm keeps its own `fetch` as it was, and one
that set a dispatcher of its own is used as is, through `fetch`.

Instrumentation stays out of the product's path: the tracer is a chunk loaded only under
its environment variable, and a call site that is off costs one test of a constant.

Keep the portable resolver usable without Node. Filesystem installation remains a
Node concern; do not add a browser filesystem layer just to make the modules uniform.
