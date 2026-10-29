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
