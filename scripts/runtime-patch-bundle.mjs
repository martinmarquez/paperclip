import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function assertPatchPath(file) {
  if (typeof file !== "string" || !/^node_modules\/@paperclipai\/[a-z0-9-]+\/(?:dist\/.+\.js|skills\/paperclip\/SKILL\.md)$/.test(file)
    || file.includes("\\") || file.includes("\0")
    || file.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new Error("Invalid runtime patch path");
  }
}

export async function captureRuntimePatches(root, manifest) {
  if (typeof manifest.baseCommit !== "string" || !/^[a-f0-9]{40}$/.test(manifest.baseCommit)) throw new Error("Invalid base commit");
  if (!Array.isArray(manifest.patches) || !manifest.patches.length) throw new Error("Empty patch manifest");
  const files = [];
  const seen = new Set();
  const realRoot = await fs.realpath(root);
  for (const patch of manifest.patches) {
    assertPatchPath(patch.file);
    if (seen.has(patch.file)) throw new Error("Duplicate patch path");
    seen.add(patch.file);
    const target = await fs.realpath(path.join(realRoot, patch.file));
    if (!target.startsWith(realRoot + path.sep)) throw new Error("Patch leaves runtime root");
    const bytes = await fs.readFile(target);
    if (digest(bytes) !== patch.sha256) throw new Error(`Patch hash mismatch: ${patch.file}`);
    files.push({ file: patch.file, sha256: patch.sha256, data: bytes.toString("base64") });
  }
  return { format: "paperclip-runtime-patches/v1", baseCommit: manifest.baseCommit,
    commits: manifest.commits ?? [], files: files.sort((a, b) => a.file.localeCompare(b.file)) };
}

export function verifyRuntimePatchBundle(bundle) {
  if (bundle.format !== "paperclip-runtime-patches/v1" || !Array.isArray(bundle.files) || !bundle.files.length) {
    throw new Error("Invalid patch bundle");
  }
  if (typeof bundle.baseCommit !== "string" || !/^[a-f0-9]{40}$/.test(bundle.baseCommit)) throw new Error("Invalid base commit");
  const seen = new Set();
  for (const file of bundle.files) {
    assertPatchPath(file.file);
    if (seen.has(file.file)) throw new Error("Duplicate patch path");
    seen.add(file.file);
    if (typeof file.data !== "string" || digest(Buffer.from(file.data, "base64")) !== file.sha256) {
      throw new Error(`Bundle hash mismatch: ${file.file}`);
    }
  }
  return bundle.files.length;
}

export async function unpackRuntimePatchBundle(bundle, destination) {
  verifyRuntimePatchBundle(bundle);
  const staging = path.resolve(destination);
  // A fresh directory prevents accidental writes into a live runtime or through pre-existing symlinks.
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    for (const file of bundle.files) {
      const target = path.resolve(staging, file.file);
      if (!target.startsWith(staging + path.sep)) throw new Error("Patch leaves staging directory");
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, Buffer.from(file.data, "base64"), { flag: "wx", mode: 0o600 });
    }
    await fs.writeFile(path.join(staging, "patch-manifest.json"), JSON.stringify({ ...bundle,
      files: bundle.files.map(({ data, ...metadata }) => metadata) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main([command, first, second, output]) {
  if (command === "capture" && first && second && output) {
    const manifest = JSON.parse(await fs.readFile(second, "utf8"));
    const bundle = await captureRuntimePatches(first, manifest);
    await fs.writeFile(output, JSON.stringify(bundle) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ files: verifyRuntimePatchBundle(bundle), bundleSha256: digest(await fs.readFile(output)) }));
  } else if (command === "unpack" && first && second && !output) {
    const bundle = JSON.parse(await fs.readFile(first, "utf8"));
    await unpackRuntimePatchBundle(bundle, second);
    console.log(JSON.stringify({ verifiedFiles: bundle.files.length }));
  } else {
    throw new Error("Usage: runtime-patch-bundle.mjs capture RUNTIME MANIFEST OUTPUT | unpack BUNDLE NEW_DIRECTORY");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
