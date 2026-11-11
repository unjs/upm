# Changelog


## v1.5.1

[compare changes](https://github.com/unjs/upm/compare/v1.5.0...v1.5.1)

### 🩹 Fixes

- **web:** Skip listing a store the install never made ([0828a8c](https://github.com/unjs/upm/commit/0828a8c))
- **dns:** Detect untouched default agent when node:http is loaded ([#42](https://github.com/unjs/upm/pull/42))

### ❤️ Contributors

- LuckTerence ([@LuckTerence](https://github.com/LuckTerence))
- Pooya Parsa ([@pi0](https://github.com/pi0))

## v1.5.0

[compare changes](https://github.com/unjs/upm/compare/v1.4.0...v1.5.0)

### 🚀 Enhancements

- Use a store on the project's mount when ~/.upm/store cannot hardlink there ([c033d73](https://github.com/unjs/upm/commit/c033d73))

### 🩹 Fixes

- **website:** Keep a linked file and its lines as the tarball and install land ([9cef58b](https://github.com/unjs/upm/commit/9cef58b))
- Read a package-lock.json bundle its parent lists without entries of its own ([#38](https://github.com/unjs/upm/pull/38))
- Follow XDG base directories for upm's own files ([#41](https://github.com/unjs/upm/pull/41))

### 🏡 Chore

- **website:** Lighter storage tab, compact panel badges ([d41b956](https://github.com/unjs/upm/commit/d41b956))
- **website:** Keep open file and picked lines in the url ([271ff8b](https://github.com/unjs/upm/commit/271ff8b))
- Update lockfile ([08899e9](https://github.com/unjs/upm/commit/08899e9))
- Apply automated updates ([fcb0a97](https://github.com/unjs/upm/commit/fcb0a97))

### ✅ Tests

- Resolve the fake mount as projectStore does, keeping Windows short names ([58f419f](https://github.com/unjs/upm/commit/58f419f))
- Drop unused aliases binding ([d817e6b](https://github.com/unjs/upm/commit/d817e6b))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Pi0x <x@pi0.io>
- Raphael Fakhri ([@RaphaelFakhri](https://github.com/RaphaelFakhri))

## v1.4.0

[compare changes](https://github.com/unjs/upm/compare/v1.3.1...v1.4.0)

### 🚀 Enhancements

- Hash stored and installed files under --verify ([4976b3f](https://github.com/unjs/upm/commit/4976b3f))
- Warn when a resolved package's engines.node excludes this Node ([665c0c9](https://github.com/unjs/upm/commit/665c0c9))
- Warn about package.json overrides, resolutions and patches that are not applied ([b0896b0](https://github.com/unjs/upm/commit/b0896b0))
- **lock:** Warn when a locked tarball url is off the configured registries ([d61d823](https://github.com/unjs/upm/commit/d61d823))
- **registry:** Warn once when a registry gives no publish dates for the release age ([bae22f4](https://github.com/unjs/upm/commit/bae22f4))
- Overrides and resolutions ([#22](https://github.com/unjs/upm/pull/22))
- Support `link:` dependencies ([#25](https://github.com/unjs/upm/pull/25))
- Install git specs on GitHub, GitLab and Bitbucket from their archive url ([#26](https://github.com/unjs/upm/pull/26))

### 🔥 Performance

- Write an older index's aliases back once a link has read them ([024235b](https://github.com/unjs/upm/commit/024235b))
- Do not race a scoped pin's document with its version route on slow headers ([b0dc1ba](https://github.com/unjs/upm/commit/b0dc1ba))
- Read an optional pin from the full packument, with its own cutoff ([a2e7514](https://github.com/unjs/upm/commit/a2e7514))
- Read an optional pin named for another os from the abbreviated packument ([aaa30c3](https://github.com/unjs/upm/commit/aaa30c3))

### 🩹 Fixes

- Read web streams without async iterator for safari compatibility ([4ef0593](https://github.com/unjs/upm/commit/4ef0593))
- Refetch damaged cached metadata and write project files atomically ([9bab3c6](https://github.com/unjs/upm/commit/9bab3c6))
- Treat out-of-range locked versions as stale and keep failed installs from writing the lockfile ([4ad66a5](https://github.com/unjs/upm/commit/4ad66a5))
- Verify tarball and store identity against the requested package ([b27ccc0](https://github.com/unjs/upm/commit/b27ccc0))
- Refill the store when a damaged entry's blobs are short too ([4d29805](https://github.com/unjs/upm/commit/4d29805))
- Follow direct links to their package dirs before calling a tree up to date ([b3b707f](https://github.com/unjs/upm/commit/b3b707f))
- Link the later of two file names a case-insensitive disk folds together ([6f27459](https://github.com/unjs/upm/commit/6f27459))
- Fetch a dropped optional again on the next install ([0a54e92](https://github.com/unjs/upm/commit/0a54e92))
- Download unframed tarball bytes once more on an integrity mismatch ([42b8aa2](https://github.com/unjs/upm/commit/42b8aa2))
- Let one install at a time relink a tree ([5a747d2](https://github.com/unjs/upm/commit/5a747d2))
- Give the tree lock up when a signal ends the install ([03f0d13](https://github.com/unjs/upm/commit/03f0d13))
- Take the tree lock over at once from a holder that died on this boot and pid namespace ([ac8abba](https://github.com/unjs/upm/commit/ac8abba))
- Keep concurrent add and install from recording each other's files ([bc78eba](https://github.com/unjs/upm/commit/bc78eba))
- Hold the tree lock under a `process` with no events, as the web shim's ([96cd547](https://github.com/unjs/upm/commit/96cd547))
- **web:** Give the shim's fs an unlink for the tree lock ([4e4a148](https://github.com/unjs/upm/commit/4e4a148))
- Wait out a lock file windows is still deleting ([f72339b](https://github.com/unjs/upm/commit/f72339b))
- Record alias names in upm.lock and bind each tarball to what its dependents declare ([f1a69b3](https://github.com/unjs/upm/commit/f1a69b3))
- Let one waiter take over a dead tree lock, and tell a dead holder at once on macOS and Windows ([f2dbcd9](https://github.com/unjs/upm/commit/f2dbcd9))
- Accept a case-folded name that opens the file the linker kept in entry checks ([72d663b](https://github.com/unjs/upm/commit/72d663b))
- Take a url tarball's bytes from the store only once they came from that url ([b568a66](https://github.com/unjs/upm/commit/b568a66))
- Trust a local tarball's stamp only for the integrity it was checked against ([7c007bf](https://github.com/unjs/upm/commit/7c007bf))
- Take a peer on an alias or a tarball only where its dependent's package.json declares it ([c08870b](https://github.com/unjs/upm/commit/c08870b))
- Warn about locked versions published after the release cutoff ([1385dfd](https://github.com/unjs/upm/commit/1385dfd))
- Hold each edge of a top to its package.json, under any name and in both maps ([1834623](https://github.com/unjs/upm/commit/1834623))
- Read a dependency named as a property every object has as any other ([6b9b7a3](https://github.com/unjs/upm/commit/6b9b7a3))
- Hold the root pins of other lockfiles to package.json ([5bbe0db](https://github.com/unjs/upm/commit/5bbe0db))
- Hold a registry package locked off its registries to the registry's integrity ([fb40df5](https://github.com/unjs/upm/commit/fb40df5))
- Hold a locked url on the registry to the package and version its path names ([8da7bb4](https://github.com/unjs/upm/commit/8da7bb4))
- Normalize CRLF shebangs when unpacking bins ([#24](https://github.com/unjs/upm/pull/24))
- Lock a link: to a directory only above the project ([bf9f7c4](https://github.com/unjs/upm/commit/bf9f7c4))

### 💅 Refactors

- Make debuging stacks better ([2e1887a](https://github.com/unjs/upm/commit/2e1887a))

### 🏡 Chore

- Improve website ([0d616d4](https://github.com/unjs/upm/commit/0d616d4))
- Basic profile script ([14a3bef](https://github.com/unjs/upm/commit/14a3bef))
- Improve profile script ([e793838](https://github.com/unjs/upm/commit/e793838))
- Update sizes ([473f9ad](https://github.com/unjs/upm/commit/473f9ad))
- Update benchs ([10f9faa](https://github.com/unjs/upm/commit/10f9faa))
- More stable benchmarks with recording ([8401584](https://github.com/unjs/upm/commit/8401584))
- Improve website ([c02477a](https://github.com/unjs/upm/commit/c02477a))
- Update benchs ([1a5afee](https://github.com/unjs/upm/commit/1a5afee))

### ✅ Tests

- Skip mode bits and unlock the read-only link on windows ([96ee9cf](https://github.com/unjs/upm/commit/96ee9cf))
- Probe tar entry names that windows treats specially ([2904ab3](https://github.com/unjs/upm/commit/2904ab3))
- Wait for the thread's request instead of a fixed delay ([582472b](https://github.com/unjs/upm/commit/582472b))
- Wait for every thread to settle instead of a fixed delay ([0f1b380](https://github.com/unjs/upm/commit/0f1b380))
- Gate the prefetch check on the tarball request and widen the slow-thread margins ([84453bd](https://github.com/unjs/upm/commit/84453bd))
- Take five flaky tests off the real clock and off timing ([6bde7dc](https://github.com/unjs/upm/commit/6bde7dc))

### ❤️ Contributors

- Pooya Parsa <pooya@pi0.io>
- Pi0x <x@pi0.io>
- Grégoire Ciles

## v1.3.1

[compare changes](https://github.com/unjs/upm/compare/v1.3.0...v1.3.1)

### 🏡 Chore

- Build after version bump in release script ([2c52b2b](https://github.com/unjs/upm/commit/2c52b2b))
- Ignore devEngine mismatch ([bce27ed](https://github.com/unjs/upm/commit/bce27ed))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v1.3.0

[compare changes](https://github.com/unjs/upm/compare/v1.2.0...v1.3.0)

### 🚀 Enhancements

- Minimal progress bar and shorter install output ([#12](https://github.com/unjs/upm/pull/12))
- **cli:** Add --verbose flag ([#18](https://github.com/unjs/upm/pull/18))
- **cli:** Add -v and --version ([#19](https://github.com/unjs/upm/pull/19))
- **cli:** `upm` alone installs ([242fa15](https://github.com/unjs/upm/commit/242fa15))
- **cli:** Report progress with OSC 9;4. ([81e79ce](https://github.com/unjs/upm/commit/81e79ce))

### 🔥 Performance

- Faster warm resolve and reuse of an existing node_modules ([#9](https://github.com/unjs/upm/pull/9))
- Faster warm resolve on large workspaces ([#15](https://github.com/unjs/upm/pull/15))
- Faster link from upm.lock with a warm store ([#14](https://github.com/unjs/upm/pull/14))
- No-op install in a large workspace without a glob ([#13](https://github.com/unjs/upm/pull/13))
- Faster cold install ([#16](https://github.com/unjs/upm/pull/16))

### 🩹 Fixes

- Share one peer version between consumers whose ranges overlap ([#10](https://github.com/unjs/upm/pull/10))
- Link undeclared deps through `.upm/node_modules` ([#20](https://github.com/unjs/upm/pull/20))

### 🏡 Chore

- Update readme ([1108606](https://github.com/unjs/upm/commit/1108606))
- Update website ([16ad722](https://github.com/unjs/upm/commit/16ad722))
- Fix bench script ([234e246](https://github.com/unjs/upm/commit/234e246))
- Update benchmarks ([89f6461](https://github.com/unjs/upm/commit/89f6461))
- Update size chart ([79b4407](https://github.com/unjs/upm/commit/79b4407))
- Update bench script ([7c62d9e](https://github.com/unjs/upm/commit/7c62d9e))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Pi0x <x@pi0.io>
- Grégoire Ciles ([@ggcls](https://github.com/ggcls))

## v1.2.0

[compare changes](https://github.com/unjs/upm/compare/v1.1.0...v1.2.0)

### 🚀 Enhancements

- Fall back to installed bins for `upm <cmd>` ([a9a38b5](https://github.com/unjs/upm/commit/a9a38b5))

### 💅 Refactors

- Reduce dist size ([7b8496f](https://github.com/unjs/upm/commit/7b8496f))
- **cli:** Improve messages ([47da6e9](https://github.com/unjs/upm/commit/47da6e9))

### 🏡 Chore

- Credit @sondreb for pkg name ([6672999](https://github.com/unjs/upm/commit/6672999))
- Rerun full benchmarks ([dc5cf3a](https://github.com/unjs/upm/commit/dc5cf3a))
- Add devEngines.packageManager ([6611add](https://github.com/unjs/upm/commit/6611add))

### ✅ Tests

- Measure startup budget as minified code ([c0c5a33](https://github.com/unjs/upm/commit/c0c5a33))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v1.1.0


### 🚀 Enhancements

- **cli:** Accept npm's command names and common flags ([4e41c4d](https://github.com/unjs/upm/commit/4e41c4d))
- Auto install when running scripts ([a20cf07](https://github.com/unjs/upm/commit/a20cf07))
- Offline mode and registry cache ([#2](https://github.com/unjs/upm/pull/2))
- Pluggable store backend ([#4](https://github.com/unjs/upm/pull/4))

### 🩹 Fixes

- **runtime:** Support browser process shims and timers ([948e59f](https://github.com/unjs/upm/commit/948e59f))

### 📦 Build

- Label obuild's libs chunk group with debugName ([aa5ee19](https://github.com/unjs/upm/commit/aa5ee19))

### 🏡 Chore

- Update docs ([15de9ef](https://github.com/unjs/upm/commit/15de9ef))
- Update docs ([8e31525](https://github.com/unjs/upm/commit/8e31525))
- Apply automated updates ([50a430f](https://github.com/unjs/upm/commit/50a430f))
- Apply automated updates ([222f014](https://github.com/unjs/upm/commit/222f014))
- Update website ([081ecc1](https://github.com/unjs/upm/commit/081ecc1))
- Finalize state files ([889261f](https://github.com/unjs/upm/commit/889261f))
- Update website ([7ef4721](https://github.com/unjs/upm/commit/7ef4721))
- Apply automated updates ([4f4d753](https://github.com/unjs/upm/commit/4f4d753))
- Improve website ([92b213a](https://github.com/unjs/upm/commit/92b213a))
- Improve website ([c63ab74](https://github.com/unjs/upm/commit/c63ab74))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Pi0x <x@pi0.io>

