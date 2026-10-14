# Fleet extension native cleanup on Node 24

Issue #3101 blocks qualification of Fleet #95; fixing Core does not qualify Fleet.
Fleet must repin the independently reviewed Core merge and rerun its native and
four reciprocal consumer gates before setting qualification or readiness.

## Defect and fix

With the previous locked `better-sqlite3` 11.10.0 rebuilt against Node 24.21.0,
the exact-source extension suites reproduced an abort in
`Statement::~Statement()` → `node::RemoveEnvironmentCleanupHook()` with
`Assertion failed: (env) != nullptr`. This can happen during allocation-driven
statement garbage collection, including after the SQLite connection was closed.
Closing a Knex pool does not destroy every JavaScript statement wrapper.

Node's legacy `node::ObjectWrap` destructor looks up the current Node environment
when removing its cleanup hook. That environment need not be current in a V8 weak
callback. The relevant upstream reports are
[Node #65446](https://github.com/nodejs/node/issues/65446) and
[better-sqlite3 #1515](https://github.com/WiseLibs/better-sqlite3/issues/1515).
Changing test failure handling or merely upgrading to the v12 legacy wrapper
would not repair this lifecycle path.

Root and Core now pin `better-sqlite3` **13.0.3**. Its
[Node-API implementation](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/src/objects/statement.cpp)
uses `Napi::ObjectWrap` and environment-bound finalizers, replacing the legacy
context-dependent destructor. The addon still registers an environment cleanup
hook to close handles at teardown. Explicit database closure remains required:
the affected fixtures register resources before setup, close listeners before
the extension plane and database, and attempt all cleanup obligations in reverse
acquisition order. Cleanup errors fail the test. Each test pool checks that every
native connection is closed and that no used/free connections remain.

DNS validation now clears its deadline timer after success, rejection or timeout.
Public-address, pinned-address and restricted-network checks are unchanged.

This is a native dependency major upgrade (including SQLite 3.53.4), requiring
Node >=22, within Core's existing >=22.12.0 requirement. Native artifacts must
come from the updated lockfile; a cached v11/v12 binary is not the fixed driver.
The Knex interface, schema migrations and application database format remain in
use and are exercised by the storage/export and retry suites. There is no
extension wire-contract change and no new Fleet readiness claim.

## Reproduction and validation

Use **Node 24.21.0** with root/workspace locked dependencies and prepared shared
and Core packages. These commands must exit zero naturally:

```sh
NODE_ENV=test npx tsx --experimental-test-module-mocks --test packages/core/test/extensionProfiles.test.ts packages/core/test/fleetExtensions.test.ts
NODE_ENV=test npx tsx --experimental-test-module-mocks --test packages/core/test/extensionProfiles.test.ts
NODE_ENV=test npx tsx --experimental-test-module-mocks --test packages/core/test/fleetExtensions.test.ts
NODE_ENV=test npx tsx --experimental-test-module-mocks --test packages/core/test/extensionNativeCleanup.test.ts
npm run typecheck -w @propr/core
```

The exit regression starts a fresh combined-suite process and rejects signals,
nonzero status and timeouts. It also runs I/O-driven statement allocation/GC on
real file-backed SQLite databases in a process and worker, with explicit closure
on successful and throwing setup paths, then waits for natural worker/process
exit. No `process.exit()`, forced test exit, native-test skip or accepted abort is
used. Separate checks inject a cleanup failure and check DNS timer ownership.

The broader native Core matrix is:

```sh
NODE_ENV=test node scripts/run-test-suite.mjs packages/core/test/fleetDataPlane.test.ts packages/core/test/instanceStorage.test.ts packages/core/test/databaseExport.test.ts packages/core/test/sqliteRetry.test.ts packages/core/test/egressProxy.test.ts packages/core/test/egressProxyAddressPolicy.test.ts packages/core/test/managedDiagnostics.test.ts packages/core/test/managedDiagnosticsPortability.test.ts packages/core/test/nativeLogAdmission.test.ts packages/core/test/taskSubmissionService.test.ts
```

## Recorded local results

On Node 24.21.0, the combined native suites passed **55/55** tests; independent
runs passed **37/37** extension-profile and **18/18** Fleet-extension tests, all
with normal zero exits and no skips. Core typecheck/build and the targeted
endpoint-policy lint check passed. The four focused cleanup regressions passed
with zero failures/skips and normal exits. Node 24.0.0 also passed the 37-test profile
suite and process/worker statement-GC fixture with the same pinned driver.

The broader Node 24.21.0 matrix passed **9/10** test files. In
`managedDiagnostics.test.ts`, 31 tests passed and two subprocess tests failed
before reaching their assertions because Node rejects the existing
`mock.module('ioredis', { namedExports: { Redis, default: Redis } })` fixture.
The same error reproduces without importing SQLite:

```sh
node --experimental-test-module-mocks --input-type=module -e "import {mock} from 'node:test'; class Redis {} mock.module('ioredis', {namedExports:{Redis,default:Redis}}); await import('ioredis');"
```

The full 33-test diagnostics suite passed on Node 22.23.3 with the updated
driver, confirming this difference is specific to the Node 24 mock fixture.

Those failures are retained as failures; no test selection, failure handling or
unrelated diagnostics fixture was changed to hide them. The passing matrix
includes the real diagnostic spool, portability, native-log admission, database
backup/export, retry, Fleet authority/transport, storage and task-submission
paths. Fleet's reciprocal qualification remains downstream work after review
and merge.

## Exact qualified bytes

The existing Fleet fixture test checks canonical schema bytes, all 14 request
fixtures, recipient and skill-result bytes, digests/MACs, capability pins and every
file listed in all three existing checksum bundles. No bundle was regenerated.
The qualified extension schema pin remains:

`d4987a10399fbbaf9b8c9483daaf26316d82a5ae5b2961d3ebdeb69c2d24e1c0`

The SHA256SUMS files themselves remain:

| Bundle | SHA-256 of SHA256SUMS |
| --- | --- |
| fleet-extensions-v1-qualified | `060c506793c27c5ca37365e9041eea3cefc087fadbf09e680bb5f1c91b525e4c` |
| fleet-extensions-v1 | `8491d7451246d018fd1bcbfa9d7575dd71fa6b57d72745f612efa0c282614cb6` |
| fleet-data-v2 | `7d212b1b2d454406ae684575c9a3b536f71bc18bb4b65bb034493ab96d6a684a` |

The strict remote skill projection, local durable admin and
`instance.manage_settings` checks, encrypted custody, identity/replay/generation
fences and private Unix transport remain covered by the unchanged assertions.
No deployment, release, public endpoint or live credential work is part of this
change.
