import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureRuntimePatches, unpackRuntimePatchBundle, verifyRuntimePatchBundle } from "./runtime-patch-bundle.mjs";

const file = "node_modules/@paperclipai/server/dist/index.js";
const bytes = Buffer.from("export const recovery = true;\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const valid = () => ({ format: "paperclip-runtime-patches/v1", baseCommit: "a".repeat(40), files: [{ file, sha256, data: bytes.toString("base64") }] });

test("captures exact modules, unpacks them, and refuses to overwrite a live directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-patch-test-"));
  try {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), bytes);
    const manifest = { baseCommit: "a".repeat(40), patches: [{ file, sha256 }] };
    const bundle = await captureRuntimePatches(root, manifest);
    assert.equal(verifyRuntimePatchBundle(bundle), 1);
    assert.deepEqual(bundle, await captureRuntimePatches(root, manifest));
    const staging = path.join(root, "staging");
    await unpackRuntimePatchBundle(bundle, staging);
    assert.deepEqual(await fs.readFile(path.join(staging, file)), bytes);
    await assert.rejects(unpackRuntimePatchBundle(bundle, staging), { code: "EEXIST" });
    assert.deepEqual(await fs.readFile(path.join(staging, file)), bytes);
    await fs.writeFile(path.join(root, file), "tampered");
    await assert.rejects(captureRuntimePatches(root, manifest), /hash mismatch/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("rejects tampered, duplicate, empty, secret, and traversal payloads before creating output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-bad-patch-"));
  try {
    const bad = [
      { ...valid(), baseCommit: undefined },
      { ...valid(), baseCommit: "not-a-commit" },
      { ...valid(), files: [] },
      { ...valid(), files: [...valid().files, ...valid().files] },
      { ...valid(), files: [{ ...valid().files[0], data: "invalid" }] },
      ...["../auth.json", "/etc/passwd", "node_modules/@paperclipai/server/dist/../../auth.js", "node_modules/@paperclipai/server/.env", "node_modules/@paperclipai/server/dist//x.js", "node_modules/@paperclipai/server/dist/..\\..\\..\\..\\outside.js"]
        .map((file) => ({ ...valid(), files: [{ ...valid().files[0], file }] })),
    ];
    for (const bundle of bad) {
      const destination = path.join(root, "output");
      await assert.rejects(unpackRuntimePatchBundle(bundle, destination));
      await assert.rejects(fs.stat(destination), { code: "ENOENT" });
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("rejects a module symlink outside the runtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-link-patch-"));
  try {
    const runtime = path.join(root, "runtime");
    await fs.mkdir(path.dirname(path.join(runtime, file)), { recursive: true });
    await fs.writeFile(path.join(root, "outside.js"), bytes);
    await fs.symlink(path.join(root, "outside.js"), path.join(runtime, file));
    await assert.rejects(captureRuntimePatches(runtime, { baseCommit: "a".repeat(40), patches: [{ file, sha256 }] }), /leaves runtime/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
