# Recover an installed runtime with local patches

A package reinstall removes local runtime patches. Keep both the source commit
and the exact installed modules before an upgrade. The bundle contains code and
the Paperclip skill only. It does not include credentials, logs, database files,
node_modules trees, or agent state.

Capture a runtime whose operator manifest lists every installed patch:

```sh
node scripts/runtime-patch-bundle.mjs capture RUNTIME_ROOT OPERATOR_MANIFEST PRIVATE_OUTPUT.json
```

The command checks each module against its recorded SHA-256. It fails on drift,
missing files, duplicate paths, and links outside the runtime. It creates a new
file with mode 0600 and prints its digest. Store the digest and source commits
with the release evidence. A hash proves integrity, not provenance: use a
manifest and bundle from the trusted operator.

Verify the bundle and reconstruct its module tree in a **new staging directory**:

```sh
node scripts/runtime-patch-bundle.mjs unpack PRIVATE_OUTPUT.json NEW_STAGING_DIRECTORY
node --test scripts/runtime-patch-bundle.test.mjs
```

Never extract into an active installation. The unpack command refuses an existing
directory. Review `patch-manifest.json` and the base commit before installing.
The bundle does not supply dependencies or certify compatibility with another
Paperclip version.

For an installation or rollback, request the native task drain and wait for
`activeRuns=0`, `pendingWakes=0`, and `quiescent=true`. Confirm that you own the
maintenance operation. Preserve a verified bundle of the current installation.
Copy only the listed modules to the matching base runtime while dispatch is
drained. Check JavaScript syntax and hashes, then restart through the existing
service manager. Verify health, startup recovery, backups and dispatch before
releasing your drain. Do not release another operator's drain or stop active work.
On failure, restore the previous verified modules while drained and recheck health.

Run the existing remote test, typecheck and build gates against the source commit
before treating it as a complete release. Narrow assertions and runtime health
do not replace those gates. Reuse current-commit evidence; do not dispatch a
duplicate pipeline or move builds onto an operator's Mac.

## Headless connection discovery

The Codex adapter preapproves only `connections_search` and `connection_request`
on the same-origin, run-scoped `/mcp/runtime-tools` gateway named
`Paperclip connections`. These tools return available access or create the human
grant/setup card. They do not authorize a provider, issue credentials, or execute
an external service action. Connection grants, tool policies, company boundaries,
token expiry, and human provider selection still apply. Other gateways retain
their approval configuration, including same-name gateways at another origin.

## Record a stopped webhook without retrying it

An operator can record verified unperformed work with the existing
`POST /api/issues/:id/recovery-actions/resolve` API and `recordOnly: true`.
Supply the exact `actionId`, `outcome: "restored"`, the task's unchanged
`sourceIssueStatus`, and `executionReconciliation` with the original `runId`,
`providerStopped: true`, `actionOutcome: "not_performed"` and observed receipts.
An HTTP502 or absent logs alone are insufficient evidence of unperformed work.

This board-only operation keeps the task, current assignee, approvals and
paused agents unchanged. It validates the recorded source, process/controller
termination and released leases, then settles the no-replay hold without
creating a continuation or retry. It can record an old reviewer's verified
outcome after the task was reassigned. Ordinary resumption retains its original
owner checks. Unknown, completed or mixed outcomes cannot use this operation.

## Recover a handoff before the first reviewer run

A review or approval handoff can be skipped while the preceding participant's
terminal run still owns an environment lease. The existing startup and periodic
assigned-issue recovery sweeps also handle a pending agent stage with no run for
that participant. They reconstruct the current stage's initial dispatch after
cleanup; no additional timer, service, or provider capacity is needed.

Admission rechecks the task's status, assignee, pending stage ID and participant
under the issue lock. Existing process/lease ownership, unknown-outcome holds,
operator pauses, interactions, company status and budget gates still apply.
Queued/running work coalesces under normal admission; unsuccessful reviewer runs
retain the existing bounded retry and escalation policy. This recovery neither
submits a review decision nor replays the preceding participant's action.

## Keep backup cadence across service restarts

Automatic backup eligibility uses the last completed backup's persisted file
mtime. Startup checks for one due backup; later checks preserve the configured
interval, retention and freshness alert threshold. A manual backup resets that
cadence, and failed attempts wait the configured interval before retrying in the
same process. Warm standby and an in-flight backup never start another copy.
Restarting the service cannot postpone an already overdue backup by another full
interval. Missed intervals coalesce into one backup.

Both backup engines write compressed output to a `.partial` path and rename it
within the backup directory only after compression and provider completion.
An interrupted write cannot appear as a new completed `.sql.gz` archive to the
health check or scheduler. Failure cleanup removes the temporary output; old
verified backups keep their normal retention policy.

A pending question addressed to the current reviewer is actionable work for that
reviewer. Assigned-issue recovery redelivers its missing first notification with
the original interaction context, even when the reviewer has unrelated old run
history. It neither answers the question nor changes its resolver. Human and
governed confirmation waits, Stops, pauses, budgets and unknown-action holds
still block dispatch. An existing run for that exact question owns its bounded
retry lifecycle; recovery cannot repeatedly start new turns for an unanswered
card. The existing review-path receipt constraint protects concurrent delivery.

If its predecessor still owns a process or lease, the initial reviewer-question
notification remains a coalesced diagnostic wait. Its durable question card is
the pending intent; a misleading live execution receipt cannot hide it from
recovery. Normal admission rechecks ownership before the eventual dispatch.
