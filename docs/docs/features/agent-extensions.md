# Instance agent extensions

Instance Settings → Integrations & MCP → Agent extensions manages native Core
extension profiles. No Connect account or Hosted control is required. The API
requires a current **durable** `instance_members` administrator with
`instance.manage_settings` for every management operation. A bootstrap username
or repository assignment alone does not establish this authority: persist the
administrator in Access first.

Profiles contain a name, enabled state, optional agent/repository scopes, explicit
MCP tool permissions and immutable skill bundle references. Every save or secret
replacement creates a new revision with timestamps and the administrator's actor
ID. Automations and ordinary New Task submissions select zero or one exact
instance/profile/revision tuple. Choose the new revision after editing a profile;
queued runs do not silently move to it. Claude and Codex task execution are the
qualified targets. Goal execution and other runtimes refuse profiles.

Core rechecks the selecting administrator, the revision's administrator, scope,
capability policy, endpoint policy and current revision at the physical launch
boundary, after network setup and capacity admission. A conditional database
write fences launch against disable, deletion, demotion and secret rotation. An
edit that wins before this boundary refuses the old launch; an edit after it
does not mutate the running revision. Completion revokes the gateway grant and
removes the temporary skill directory, including when execution fails.

## MCP policy

V1 supports stateless HTTPS MCP endpoints with JSON responses. Each server has a
stable name, an explicit list of allowed tool names, a read/write capability and
optional write-only bearer authentication. A write server also requires the run's
write authorization; report phases refuse it. `initialize`, `ping`, the initialized
notification, `tools/list` and explicitly listed `tools/call` are the only gateway
methods. Resource APIs, prompts, server-initiated requests, response cookies,
upstream session headers, SSE and stateful transports are unavailable. Connectivity
validation returns only server names and reachable booleans.

Endpoints must use port 443 and have no credentials, query parameters or fragments.
Core resolves and checks all DNS answers on every connection, then dials only a
vetted address while verifying the original TLS identity. Redirects, private,
loopback, link-local, metadata and reserved destinations are refused. V1 has no
operator-installed local catalog runner: internal exceptions and local stdio are
therefore unavailable. Customer commands, host paths, Docker sockets and bind
mounts are rejected by the shared strict contract.

Core bounds each request to 64 KiB, each response to 1 MiB, four simultaneous
connections, 256 requests and 16 MiB of response traffic per run, with a ten-second
connection/response deadline. A run reserves a full response budget during each
request and refunds unused bytes after successful responses. Failed and oversized
responses consume the full reservation. Grants expire after twelve hours.
The existing task network policy is preserved; restricted runs additionally
require the remote endpoint in the existing run allowlist. The Core API gateway derives its container-reachable address from the existing
`PROPR_AGENT_MCP_URL` (or `PROPR_INTERNAL_API_URL`) setting and must itself
be reachable under that policy; profiles do not open internal
network destinations or relax enforced egress restrictions.

Provider launch arguments contain gateway URLs and environment **names** only.
The remote credential stays encrypted in Core and is never sent to the executor.
Run tokens are also redacted across subprocess chunk boundaries before live
output, task buffers, diagnostics or session inspection.
Bearer/header values, exact configured secrets and their common encodings are
redacted from gateway output, including tool descriptions. Upstream errors and
connectivity validation disclose no response content. Claude uses a strict MCP
catalog. Codex ignores its ambient user configuration while retaining the existing
`CODEX_HOME` authentication; profile runs refuse `.codex/config.toml` in the task
workspace or its ancestry because the qualified CLI has no project-config ignore
switch. These limitations are displayed in the editor.

## Skills

Import a strict tar/tar.gz archive (5 MiB compressed, 4 MiB expanded, 256 entries),
or a GitHub repository authorized by the caller at an exact 40-character commit
and relative directory. Imports verify the commit object and materialize file
contents, source provenance and a SHA-256 content digest. Branch and tag names
are refused. Reimport to update a skill; saved bundles never fetch mutable source
contents at launch.

Archives reject traversal, absolute paths, links, devices, duplicate/case-colliding
paths, extension headers and decompression bombs. A root `SKILL.md` must contain
valid YAML frontmatter with `name` and `description`. Optional `requirements` is
a list of declarations displayed in the editor and task instructions. Declarations
never install endpoints, secrets or capabilities. Scripts and assets remain
untrusted task input and are never executed during import.

Only selected bundles are copied into a unique temporary directory under
`PROPR_EGRESS_SOCKET_DIR/extensions/<instance-id>`, verified against the saved digest and mounted read-only
at `/opt/propr/extensions`. The launch prompt identifies their `SKILL.md` paths.
No bundle is installed into a provider or executor home. Docker-outside-Docker
deployments use the existing `HOST_PROPR_EGRESS_SOCKET_DIR` mapping; a
missing/unusable bind namespace fails the launch. Other task mounts, sandbox
settings and repository isolation remain in force.

## Backup, restore and reset

Profile revisions, immutable bundle contents and AES-256-GCM encrypted credential
custody live in the customer database. Encryption uses the existing private
credential trust root (`PROPR_CREDENTIAL_ENCRYPTION_KEY`, then
`SYSTEM_TASK_SECRET`, then `SESSION_SECRET`) with domain separation and
instance/profile/revision authenticated binding. Configure the same root on API
and workers. Never store the root in profile input.

Normal list/read/history/config projections contain only authentication field
names and presence markers. The existing full database export includes encrypted
custody and bundle contents, so treat it as a private instance backup. Export does
not include the encryption root; back that up separately using the existing
operator secret-custody procedure. Restore the database and the matching root
together. A different root fails decryption closed. Revision and the dedicated `extension_instance_identity` database row
must be restored together; IDs from another installation cannot be substituted.
The native database export removes ephemeral run grants, so an old execution
token cannot regain access after restore. Normal execution revokes grants on
completion; abandoned grants expire after twelve hours. Operator raw database
backups must also discard `extension_run_grants` before restoring service.

A full instance reset removes the database (including profiles, bundles, revision
history and encrypted secret material) and its data directory. After stopping tasks, discard temporary extension
staging under `PROPR_EGRESS_SOCKET_DIR/extensions/<instance-id>` as well. A queue reset alone is not a full instance reset. Profile
deletion tombstones new selection/launches while retaining encrypted revisions for
already running snapshots. Do not delete staging from an active task.

## Validation

Deterministic Core and API tests cover durable local administrator success,
non-administrator and stale-session denial, CSRF preflight, tenant/profile/revision
substitution, capability and scope checks, rotation, disabling/deletion, URL and
DNS rejection, archive attacks, encrypted custody, sentinel redaction and temporary
mount cleanup. A synthetic TLS MCP fixture proves a selected gateway grant can
call the approved tool, an unselected grant cannot, redirects are refused and
oversized responses fail. Qualified pinned Claude/Codex CLI tests check exclusive
MCP catalogs and environment authentication. The browser test renders the actual
settings editor and checks security/provenance/history and write-only controls.
