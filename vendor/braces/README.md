# Vendored `braces` with depth guards

This directory is a locally vendored build of `braces` that remediates
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
(high severity, stack-exhaustion denial of service through deeply nested
brace patterns, affecting every published `braces` release `<= 3.0.3` with
no upstream fix available). It is wired in through the root `package.json`
`overrides` entry `"braces": "file:vendor/braces"` and replaces the
temporary audit exception documented in
`docs/dependency-audit-exceptions.md`, which expired on 2026-10-17.

## Provenance

- Base: upstream [`braces@3.0.3`](https://registry.npmjs.org/braces/-/braces-3.0.3.tgz)
  (MIT, license retained in `LICENSE`).
- Patch: the guard-only nesting-depth backport published as
  [`@dieub/braces-depth-guard@3.0.3-pn.3`](https://registry.npmjs.org/@dieub/braces-depth-guard/-/braces-depth-guard-3.0.3-pn.3.tgz).
  The full tarball diff against upstream 3.0.3 was reviewed before
  vendoring: the file set is identical (no added files, no install
  scripts), and the code changes are limited to a `MAX_DEPTH` constant,
  `getMaxDepth`/`getMaxLength` option clamps in `lib/utils.js`, depth
  counters in the recursive walkers of `lib/parse.js`, `lib/compile.js`,
  `lib/expand.js` and `lib/stringify.js` that throw a controlled
  `SyntaxError`/`RangeError` past 100 levels of nesting, and a
  cycle-guarded queue-owner lookup in `lib/expand.js`.
- Only `package.json` (name/version/metadata) and this README differ from
  that reviewed patch; `index.js` and `lib/` are byte-identical to it.

## Version

The version `3.0.4-depthguard.1` is intentionally above `3.0.3` and is not
a published upstream release. Both open advisories (`GHSA-grv7-fg5c-xmjg`
`< 3.0.3`, `GHSA-vfj7-8cjw-p6xm` `<= 3.0.3`) match by version-number
comparison including prereleases, so the vendored package must sort above
`3.0.3`; a `3.0.3-*` prerelease (such as the npm alias override this
replaces) matches **both** advisories and fails GitHub dependency review.

## Maintenance

If upstream `braces` publishes a release above `3.0.3` that fixes
GHSA-vfj7-8cjw-p6xm, delete this directory, remove the `braces` override
from the root `package.json`, regenerate `package-lock.json`, and re-run
`npm run audit:runtime` and `npm run desktop:audit:packaging`.
