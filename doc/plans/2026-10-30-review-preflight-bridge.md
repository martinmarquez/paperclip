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
There are no new dependencies, providers, credentials or default grants.

The two SQL tables are deliberately not an implicit startup migration. Their
DDL is shipped separately and is exercised only in a throwaway PostgreSQL
cluster by CI. Applying it to an instance requires the existing approved native
migration/operator path and a separate, concrete activation decision. No runtime
installation or database application follows from importing the module.

Every accepted reservation and stored evidence result records native activity.
Failure to acknowledge the reservation's audit prevents extraction. An uncertain
reserve, publication or query is never replayed. Evidence uses canonical JSON
hashing so a PostgreSQL `jsonb` roundtrip does not invalidate its digest. A hash
does not attest authority or isolation: the result always says `HOLD`,
`diagnosticOnly: true`, `dispatchAllowed: false` while production attestation is
unavailable. Missing sources do not become a PASS.

## Required evidence

The unchanged release-pinned canonical workflow retains all of its checks. The
same PR workflow then runs `test-review-preflight-sql-store-pg.sh` on a standard
GitHub-hosted runner, only for the public maintenance fork. It never falls back
to a private/custom paid runner. The physical harness creates its own Unix-socket
cluster and invokes the real store and native client adapter from two Node
processes. It checks restart, company/actor scope, idempotency, quota, expiry,
publication, cancellation, actual JSONB readback and teardown. It refuses an
inherited/shared database target. Typechecking, unit tests and build still come
from canonical CI; local syntax checks are not those gates.

## Activation remains separate

Before host activation identify and review the actual principal, fixed sources,
transactional publication authority, protected channel, applied enforcer and
manifest. The supplied test authority is synthetic and must never be used in an
instance. Neither this integration nor its CI result dispatches reviewers,
resumes paused agents, changes grants, certifies H1/V02 or removes release gates.
`FILE_RETENTION_PAUSED`, user Stops and the existing quota reserve remain intact.
