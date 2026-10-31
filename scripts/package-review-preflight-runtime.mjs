// Runs only in the public maintenance CI job. No credentials or host files enter the bundle.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(sourceSha, process.env.PAPERCLIP_CANDIDATE_SHA);
const groups = [
  ["server", "@paperclipai/server", ["app", "index", "routes/openapi", "routes/review-preflight-bridge", "routes/review-preflight-operator-page", "services/heartbeat",
    "services/native-runtime/native-session-executor", "services/review-preflight-bridge", "services/review-preflight-sql-store",
    "services/review-preflight-authority", "services/review-preflight-board-reader", "services/review-preflight-integration"]],
  ["packages/db", "@paperclipai/db", ["index", "review-preflight-sql", "schema/index", "schema/review_preflight"]],
  ["packages/shared", "@paperclipai/shared", ["constants"]],
  ["packages/adapters/codex-local", "@paperclipai/adapter-codex-local", ["index", "server/execute"]],
  ["packages/paperclip-runner", "@paperclipai/server/dist/vendor/paperclip-runner", ["drivers/codex/codex-security-config", "drivers/codex/codex-app-server-driver-impl"]],
];
const files = [];
for (const [sourceRoot, targetPackage, modules] of groups) for (const module of modules) {
  const sourcePath = `${sourceRoot}/src/${module}.ts`;
  const source = await readFile(sourcePath, "utf8");
  const output = ts.transpileModule(source, { fileName: sourcePath, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, esModuleInterop: true, isolatedModules: true } });
  assert.equal(output.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0, sourcePath);
  const target = targetPackage.includes("/vendor/") ? `node_modules/${targetPackage}/${module}.js` : `node_modules/${targetPackage}/dist/${module}.js`;
  files.push({ file: target, content: output.outputText, sha256: sha256(output.outputText), sourcePath, sourceHash: sha256(source) });
}
for (const module of ["migrations/0306_review_preflight.sql", "migrations/meta/_journal.json"]) {
  const sourcePath = `packages/db/src/${module}`;
  const content = await readFile(sourcePath, "utf8");
  files.push({ file: `node_modules/@paperclipai/db/dist/${module}`, content, sha256: sha256(content), sourcePath, sourceHash: sha256(content) });
}
const bundle = { schemaVersion: 1, sourceSha, baseSha: "6543cb67b11c8c7468a7845522a97ee519cfb39f",
  tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(), files };
await mkdir("runtime-candidate", { recursive: true });
const bytes = gzipSync(JSON.stringify(bundle));
await writeFile("runtime-candidate/review-preflight-runtime.json.gz", bytes);
console.log(JSON.stringify({ sourceSha, files: files.length, bytes: bytes.length, sha256: sha256(bytes) }));
