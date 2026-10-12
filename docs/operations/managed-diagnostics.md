# Managed diagnostic producer (policy 1)

This is the application/provider dependency of Fleet issue 78. It does **not** deploy anything, implement encrypted transport, or change 60-day DB/config restore backups. These diagnostics contain customer content even after credential redaction. They are tenant-private, never preview assets, GitHub attachments/comments, or public download routes.

## Activation and lifecycle

Hosted activation uses the existing server-side `PROPR_FLEET_CONTROL_SECRET` boundary. Self-managed installations must explicitly set `PROPR_MANAGED_LOGS=1`. Both require `PROPR_INSTANCE_ID`. Linux `/proc/self/fd` is required; no fallback follows symlinks on unsupported platforms.

`PROPR_DIAGNOSTIC_ROOT` defaults to `/usr/src/app/data/managed-diagnostics`, within the launcher's existing persistent data mount. Its parent must exist. The producer creates the final directory with mode 0700 and its database with mode 0600; existing roots must have the same private permissions and process owner. A root is bound to exactly one instance and policy. Never share it between tenants, mount it into an agent container, or point it at credentials, a personal home, or a worktree.

Pino's real write hook captures application records. The shared Docker executor captures provider stdout/stderr, as do the separate Codex app-server, Claude native-goal and Antigravity native-goal launch paths. Capture tees existing output; it does not replace Redis/UI streams or resume data. The daemon snapshots explicitly allowlisted native files every 30 seconds, reading only configured per-agent managed roots or explicit launcher provider mounts. The launcher mounts these roots into the daemon as well as the existing worker/API mounts. Vibe's worker snapshots its assigned runtime home periodically and before the existing runtime cleanup.

An unavailable spool emits a rate-limited constant warning without an exception, path, credential or record payload. Storage failures are retried on subsequent capture; in-process lost-byte counters are reported when storage becomes writable again. A crash while storage is unavailable cannot durably record its exact lost-byte count. `historyComplete` is consequently **always false** in this producer. Fleet must establish off-site coverage from its own verified objects and producer gaps; it must not interpret a successful CLI exit or collection timestamp as proof of 14 complete days.

## Source and version audit

Audited from `Dockerfile.agent`, `agents/version/types.ts`, `configManagerAgents.ts`, the five Docker argument builders, `agentLogin.ts`, `docker/launcher/orchestrator.mjs`, provider entrypoints, and the native-goal/runtime helpers. This checkout's image defaults are below; selectable tags/custom images can differ. These are repository-supported versions, **not live container acceptance results**. Tests use filesystem fixtures of these managed layouts, not installed provider CLIs or a Hosted production instance.

`M` is the configured `PROPR_MANAGED_CREDENTIALS_DIR`, not the application's `HOME`. Browser-created credential paths map to `M/<agent-id>/<suffix>`. Explicit `HOST_*` mappings are mounted HOST:HOST into application containers. Paths below are relative to the identified provider root unless stated otherwise.

| Provider/version | Host and agent-container mapping | Diagnostic/session allowlist | Protected/excluded native state | Writer lifetime and safe mechanism |
| --- | --- | --- | --- | --- |
| Application / Pino 9 | Application stdout; private spool under mounted data | Complete JSON records from Pino hook | Existing DB-backed task/LLM history stays under its existing policy | Application process; managed capture owns rotation. Fleet owns stdout/journald/Docker rotation. |
| Codex 0.160.0 | `M/<id>/.codex` or explicit `CODEX_CONFIG_PATH`/`HOST_CODEX_DIR` → `/home/node/.codex:rw` | `log/codex-tui.log`; `sessions/YYYY/MM/DD/rollout-*.jsonl`; same under `archived_sessions` | `auth.json`, config.toml, token/auth stores never exported; `state_<n>.sqlite` and `logs_<n>.sqlite` plus WAL/SHM measured and protected, not copied as files | Exec/app-server can keep descriptors open for the task/goal. No verified writer-reopen contract is assumed. Snapshot complete append records; rotate the managed copies. Native SQLite diagnostics require a future schema-aware reader and remain protected. |
| Claude 2.1.284 | `M/<id>/.claude` or explicit `CLAUDE_CONFIG_PATH`/`HOST_CLAUDE_DIR` → mounted Claude home | `debug/*.txt`; `projects/<slug>/*.jsonl`; `projects/<slug>/<session>/subagents/agent-*.jsonl` | `.credentials.json`, settings/config, caches excluded; `history.jsonl` measured/protected; transcripts stay available for native goals/resumption | Task/goal process; no signal/reopen assumed. Pinned read-only snapshots plus stdout/stderr capture; no rename/truncate of active transcript or debug files. |
| Antigravity 1.2.4 (release 6085322963025920) | `M/<id>/.gemini`, legacy explicit root → `.gemini-source`; entrypoint may copy selected auth into disposable `/tmp/propr-antigravity-home/.gemini` | In a mounted root: `antigravity-cli/log/*.log`, `antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl`; managed stdout/stderr includes native-goal segments | `antigravity-cli/antigravity-oauth-token`, settings, arbitrary brain/project/cache contents excluded | Task/goal process. Disposable container-only files are not falsely reported as mounted history. No native rotation/reopen proven; mounted append history is snapshotted and retained. Existing transient transcript/UI handling remains unchanged. |
| OpenCode 1.18.31 | `M/<id>/.config/opencode`; sibling `M/<id>/.local/share/opencode` or explicit `HOST_OPENCODE_DATA_DIR` supplies credentials. Runtime uses disposable XDG data via `PROPR_EPHEMERAL_STATE=1` | Mounted data root `log/*.log` when present; managed stdout/stderr for every execution | `auth.json`, `account.json`, config excluded; mounted `opencode.db`/WAL/SHM measured/protected, never exported | Runtime native DB/logs can be container-only; no broad copy or SQLite live-file copy. Captured stream is the supported diagnostic history for disposable runs. |
| Vibe 2.25.8, Python 3.12 | Explicit `.vibe` source is read-only. Runtime: `VIBE_PROMPT_CACHE_DIR/propr-vibe-runtime/propr-vibe-home-*` assigned by worker → `/tmp/propr-vibe-home`, also `HOME`/`VIBE_HOME` | Assigned runtime `logs/session/<id>/messages.jsonl`, plus stdout/stderr; same allowlist in an explicit mounted source | config.toml, credentials.json, .env, prompt cache files, skills and secrets excluded | Task-local runtime; snapshot while active and on child close, before existing cleanup. Does not add or promise Vibe native-goal resumption. |
| agent-tank 0.9.11 | Auxiliary runtime package in agent image, not a sixth `AGENT_TYPES` provider | Its diagnostic messages on the owning provider's captured streams | No extra home scan | Shares execution lifetime and stream policy. |
| Shared `/tmp/claude-logs` | Launcher/Claude bind mount, not an isolated per-agent home | **No directory-wide collection**; associated execution stream is already captured with known agent identity | Conversation/output JSON is used by existing UI/session mappings. Unknown ownership is reported as `ownership-unverified`; nothing is removed | Multiple task writers/watchers, including JSON snapshot rewrites; cannot prove tenant/task ownership or safe reopen from filenames alone. |

Only these exact structural allowlists are traversed. New provider versions/formats require review of fixtures and this table; unknown/unparseable records are dropped with gaps, not shipped as raw bytes. Missing optional directories are valid. Native state has no archive-retrieval dependency because this policy never prunes it. It does not assert a complete byte inventory of excluded, unrecognized, or container-only state.

Known auth stores are opened solely to obtain redaction values (bounded to 64 KiB per store, 128 KiB aggregate); their contents never become export records. Malformed/unsafe auth stores refuse the corresponding snapshot. Structured auth/token/password/secret/header fields, known token prefixes, JWTs, bearer/basic auth, credential assignments and URL credentials are redacted, along with configured environment credentials and run-specific injected credentials. Timestamp/severity-prefixed single-line native text and structured JSON objects are supported. Unknown text/continuation lines and PEM/binary/oversized/malformed structured records are rejected. Redaction is versioned and conservative, not a claim to recognize every possible secret or remove customer content.

## Bounds and protection

| Limit (policy 1) | Value |
| --- | --- |
| Record / uncompressed segment | 64 KiB / 256 KiB |
| Compressed per source / total outbox payload | 8 MiB / 64 MiB |
| Segments / tracked source cursors | 1,024 / 2,048 |
| SQLite main database | 96 MiB max pages, 4 KiB pages |
| SQLite journal | DELETE mode; at most the bounded database's modified pages plus journal headers; no unbounded WAL. Budget **200 MiB** for main DB plus journal. |
| Collection read / entry count / traversal deadline | 1 MiB / 4,096 entries / 250 ms per provider sweep |
| Transaction record processing / SQLite lock wait | 250 ms CPU work budget / 100 ms (initial schema setup 1 second) |
| Credentials / nesting | 512 values and 512 KiB redaction input; 32 structured-record levels |
| Protected native source / aggregate admission warning | 256 MiB / 1 GiB measured retained native state |
| Daemon roots | At most 128 enabled agents; 2-second pass budget checked between roots, rotating fairly between passes |

Segments contain only redacted canonical JSONL. UTC day changes seal the preceding day's segment; crossing the size limit rolls earlier. A private export seals its segment immediately. No active provider file is rotated: only the producer-owned copies rotate. Compression is deterministic gzip, with bounded decompression of at most one segment when extending an unsealed segment. There is no multi-GB read, full recursive listing, or unbounded capture queue. An idle segment can remain unsealed until the next write/export; no subsequent UTC day's records are appended to it.

SQLite IMMEDIATE transactions serialize rotation/export/prune and commit the native inode, bounded anchor fingerprint and newline cursor with the records. Duplicate concurrent snapshots fail cursor CAS. Replaced/truncated files expose a gap. Oversize unfinished records are discarded through their terminating newline; their tail cannot become a supposedly safe new record. Directories are opened component-by-component with NOFOLLOW and pinned via Linux descriptors; files require regular type, single link and directory-owner match, and are opened NONBLOCK/NOFOLLOW. FIFOs, devices, hardlinks, symlinks, traversal and swapped ancestors are refused or remain bound to the original descriptor. The spool is outside all provider roots and accessible only to the trusted application/Fleet OS principal.

Native session ownership does not authorize deletion, even for completed tasks: running, recoverable and unknown tasks all keep their state. Measured protected capacity blocks **new** agent launches and appears in status. It never kills an existing task. An incomplete/unsafe native inventory conservatively triggers the same warning when the retained byte count is unknown. Operators must expand storage or resolve ownership/state retention; a daily timer cannot safely cap an uncooperative active native writer. Container-only native files and the ambiguous shared directory are explicitly outside that measured bound.

## Private Fleet protocol

Run in the application environment (source development uses `npx tsx scripts/managed-diagnostics.ts`):

```sh
node dist/scripts/managed-diagnostics.js status
node dist/scripts/managed-diagnostics.js export
node dist/scripts/managed-diagnostics.js ack SEGMENT SHA256 --encrypted-upload-readback-verified
```

`status` emits policy/redaction versions, instance, all source identities, next sequence, cumulative dropped bytes/gaps, last successful clean collection, protected reason/bytes, capacity warnings, and compressed spool usage. No paths, credentials or record contents appear in status. A last-success timestamp denotes collection, not upload or complete history.

`export` emits `null`, or one JSON object:

```json
{
  "manifest": {
    "schemaVersion": 1,
    "policyVersion": 1,
    "redactionVersion": 1,
    "tenantPrivate": true,
    "instance": "tenant-instance",
    "provider": "codex",
    "agent": "agent-id",
    "source": "stdout",
    "sourceId": "sha256-of-source-identity",
    "segment": 42,
    "utcDay": "2026-10-12",
    "collectionWindow": { "start": 1791763200000, "end": 1791763201000 },
    "firstSequence": 1,
    "lastSequence": 20,
    "compressedBytes": 1000,
    "uncompressedBytes": 4000,
    "sha256": "sha256-of-exact-gzip-bytes",
    "encoding": "gzip-jsonl",
    "droppedBytes": 0,
    "gaps": 0,
    "historyComplete": false,
    "lastSuccessfulCollection": 1791763201000
  },
  "gzipBase64": "..."
}
```

Native `source` is a SHA-256 of its allowlisted relative filename; absolute filesystem/repository paths are not in manifests. Times describe **collection**, not provider event time. Sequence is monotonic per tracked source, including rejected input records. Discarded oversize byte ranges are also counted as gaps even when a complete record could not be assigned a sequence. Gap/dropped-byte counts are cumulative and can change between exports of the same immutable payload.

Fleet must use a private pipe, validate instance binding, digest and lengths, encrypt before off-site upload, verify a readback, then acknowledge that exact sealed segment/digest. An interrupted export/upload is retried from the same oldest unacknowledged segment. Export alone does not acknowledge. Acknowledgement permits immediate local pruning; retrying the most recent acknowledgement is idempotent. Fleet owns encryption keys, transport, remote coverage/gap reporting and the 14-day encrypted diagnostic retention policy. Do not attach the envelope to a task or GitHub.

Outage policy: keep unacknowledged data regardless of age; once any byte/file-count cap is reached, drop **new diagnostic copies** and persist gaps/dropped bytes. Native state and UI logs remain intact. No silent unacknowledged eviction, no promise of 14-day local storage, and no claim of full remote history. A saturated source/cursor inventory is visible and prevents new launches. Recovery does not clear historical gap counters. Exact losses during ENOSPC/process death may be unknown, so Fleet must report an interval of unknown coverage rather than infer zero loss.

## Verification and limits of evidence

`packages/core/test/managedDiagnostics.test.ts` exercises real temporary files and SQLite, UTC midnight and multiple rolls, deterministic sealed retry, cursor CAS/restart, active Codex/Claude writer descriptors, all five provider layouts, unchanged credentials/resume files, private CLI export/ack and the real application logger hook. It covers secret canaries, absent acknowledgement, partial/oversize records, symlink/hardlink/FIFO/ancestor replacement, real SQLite-full and injected ENOSPC commit failure, concurrent processes, and a sparse 3 GiB provider file with a bounded RSS assertion. Existing logger, Docker execution/watchdog, native goals, provider agents and launcher suites are also relevant.

No live Hosted instance, installed provider-version behavior, encryption/readback service, or production acceptance is claimed. Fixtures validate the repository integration contract; Fleet must perform end-to-end private upload/readback and outage acceptance against deployed image digests. No UI changes or visual preview are involved.
