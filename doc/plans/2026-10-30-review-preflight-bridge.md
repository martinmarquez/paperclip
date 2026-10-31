# Review preflight bridge on the updated maintenance runtime

Issue: REN-4950. Base: `6543cb67b11c8c7468a7845522a97ee519cfb39f`.

The bridge accepts one server-selected subject per company/hour and retains
uncertain reservations across retries and process restarts. Board sessions may
request extraction; only the two configured reader agents with a native JWT and
an exact request-scoped permission may read the sanitized result. Reviewer IDs,
legacy keys, other companies and arbitrary request subjects remain denied.

`createApp` accepts an optional `reviewPreflightBridge` host integration. Absent
configuration installs no routes. The host supplies the operator/reviewer/reader
allowlists, subject, exact origin, live permission checks and Board/host reader.
It creates the store with `ReviewPreflightSqlStore` and
`createReviewPreflightSqlDatabase(db)`. The native adapter uses a dedicated
connection for each transaction so cancellation never closes a shared client.
It gives PostgreSQL a server-side statement deadline based on the remaining
transaction time. Cancellation observes the pinned postgres.js canceller promise
(its public `cancel()` discards it), allows a bounded acknowledgement interval,
then closes only the dedicated connection. Physical CI requires external
cancellation to finish before the statement timeout and leave no live query.
It reuses the already installed TOML parser. There are no new services,
providers, credentials or default grants.

The two SQL tables now use the additive native migration `0306_review_preflight`.
The schema, migration journal and Drizzle snapshot are included. CI compares the
two table declarations with that snapshot, then applies the real migration to its
throwaway PostgreSQL cluster. Startup refuses configured activation when the
native migration is absent. Loading the reader does not create tables or grants.

Every accepted reservation and stored evidence result records native activity.
Failure to acknowledge the reservation's audit prevents extraction. An uncertain
reserve, publication or query is never replayed. Evidence uses canonical JSON
hashing so a PostgreSQL `jsonb` roundtrip does not invalidate its digest. A hash
does not attest authority or isolation: the result always says `HOLD`,
`diagnosticOnly: true`, `dispatchAllowed: false` while production attestation is
unavailable. Missing sources do not become a PASS.

## Required evidence

The unchanged release-pinned canonical workflow retains all of its checks. The
same PR workflow also runs `test-review-preflight-sql-store-pg.sh` on a standard
GitHub-hosted runner, only for the public maintenance fork. It never falls back
to a private/custom paid runner. The physical harness creates its own Unix-socket
cluster and invokes the real store and native client adapter from two Node
processes. It checks restart, company/actor scope, idempotency, quota, expiry,
publication, cancellation, actual JSONB readback and teardown. It refuses an
inherited/shared database target. Typechecking, unit tests and build still come
from canonical CI; local syntax checks are not those gates.
The pinned workflow owns lockfile resolution; PRs must not commit its generated lockfile.

## Activation remains separate

Before host activation identify and review the actual principal, fixed sources,
transactional publication authority, protected channel, applied enforcer and
manifest. The supplied test authority is synthetic and must never be used in an
instance. Neither this integration nor its CI result dispatches reviewers,
resumes paused agents, changes grants, certifies H1/V02 or removes release gates.
`FILE_RETENTION_PAUSED`, user Stops and the existing quota reserve remain intact.

## Board and host integration

Set `PAPERCLIP_REVIEW_PREFLIGHT_CONFIG` to an absolute, regular, owner-only JSON
file owned by the server UID. Symlinks and files over 128 KiB are rejected. Its
strict schema is exported as `preflightIntegrationSchema`: `scope`, `subject`,
`publicOrigin` (exact HTTPS origin), `auditWindow` (`from`/`to`, at most 24 hours),
and `hostReceiptPath`. Do not put credentials in this file.

The server creates the real store and publication authority from its native DB.
The authority requires active native membership and an explicit scoped grant in
`principal_permission_grants`. Scope includes `companyId`, `subjectSha`, and
`expiresAt` no more than one hour ahead. Evidence-read also requires `requestId`.
Unscoped grants do not suffice. Publication holds shared locks on these same
native grant and membership rows until commit. Native revocation takes effect
before the next publication. The physical CI fixture verifies that race.

The Board reader uses only the current request's session cookie, in memory, for
fixed loopback GET routes. It follows no redirect and limits each JSON response
to 128 KiB. Credentials are discarded before hashing and collection. Audit DTOs
are filtered to both configured reviewer IDs. The protected host receipt contains
two recent, subject-bound canary records. A record includes the native agent
configuration hash, applied profile hash, UID/GID, mounts, source/scratch paths,
network policy and six successful calibration checks, including the provider's
profile acknowledgement. The reader compares current native configuration and
expires observations after 15 minutes. Missing evidence remains UNKNOWN.

## Native review isolation

For the two admitted reviewers only, an operator can set adapter config
`engine: "cli", reviewReadOnly: true`. The production `codex_local` CLI path
uses a fresh private home, retains the existing model/provider, and excludes
ambient permissions, hooks, unrelated MCPs and session state. Arbitrary extra
arguments and resume are rejected. It does not install a CLI at execution time.
Before inference, an app-server handshake without `turn/start` must confirm the
same default permission profile used by `codex exec`; a legacy project sandbox
override fails closed. The native profile makes source and Git metadata read-only,
permits writes only in private scratch, and denies shell network, browser use,
web search, code mode and remote plugins. Command environment inheritance is off.
Credentials stay outside the command sandbox; refreshed OAuth credentials use
the existing identity-aware atomic copy-back before private-home cleanup.
ACP and remote fallback are rejected. The stored role boundary survives task/router
overrides, and the run snapshot pins its review mode across later configuration edits.

The only review MCP gateway is bound to the authenticated run's own task. It can
read task context/comments/documents, checkout that task, save a revision-checked
document, and record a blocked/review/done outcome through existing native API
routes with the real run audit header. Arbitrary paths, other task IDs, assignment
changes, project creation and wake requests are unavailable. Cancellation and
identity checks remain native. This lets an isolated reviewer finish its report
without granting shell access to the control-plane token or network.

This option is not enabled by importing code or starting the bridge. A Linux CI
pass does not certify Darwin enforcement. Calibrate the exact installed CLI on
the actual host without a model turn, then bind the receipt to current role
configuration and subject. Hold files under the existing retention policy.

The native operator form at
`/api/companies/{companyId}/review-preflight-extractions/new` uses the existing
Board browser session and the same scoped run permission. Opening it performs
no extraction. One explicit button sends an empty POST with a per-page
idempotency key. It uses an inline script nonce, a restrictive CSP and no cached
content, retries or polling. Reader agents cannot open it. It adds no frontend
bundle, dependency or model execution.
