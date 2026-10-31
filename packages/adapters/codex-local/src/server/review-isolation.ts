import { mkdtemp, readFile, writeFile, realpath, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse, stringify } from "smol-toml";

export const REVIEW_PROFILE = "paperclip-runner-workspace-read-only";
const disabledFeatures = ["apps", "plugins", "multi_agent", "memories", "image_generation",
  "browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser",
  "code_mode", "code_mode_only", "remote_plugin"];

/** Project settings must not restore a writable legacy sandbox or host tools. */
export function reviewIsolationArgs(cwd: string, home: string, scratch: string, source: NodeJS.ProcessEnv = {}): string[] {
  for (const root of [cwd, home, scratch]) {
    if (!path.isAbsolute(root) || path.resolve(root) === "/") throw new Error("review_isolation_root_required");
  }
  const gitRoots: unknown = JSON.parse(source.PAPERCLIP_GIT_METADATA_ROOTS ?? "[]");
  if (!Array.isArray(gitRoots) || gitRoots.some(root => typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) === "/")) {
    throw new Error("review_isolation_git_roots_invalid");
  }
  const quote = JSON.stringify;
  const filesystem = `{":root"="none",":minimal"="read",":tmpdir"="none",${quote(home)}="none",${[...new Set([cwd, ...gitRoots])].map(root => `${quote(root)}="read"`).join(",")},${quote(scratch)}="write",":workspace_roots"={"."="read"}}`;
  const commandEnv = { HOME: scratch, TMPDIR: scratch, ...(source.PATH ? { PATH: source.PATH } : {}) };
  return Object.entries({
    default_permissions: REVIEW_PROFILE,
    approval_policy: "never",
    web_search: "disabled",
    "shell_environment_policy.inherit": "none",
    "shell_environment_policy.include_only": ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
    "shell_environment_policy.set": commandEnv,
    ...Object.fromEntries(disabledFeatures.map(feature => [`features.${feature}`, false])),
  }).flatMap(([key, value]) => ["-c", `${key}=${key.endsWith(".set")
    ? `{${Object.entries(commandEnv).map(([name, entry]) => `${name}=${quote(entry)}`).join(",")}}` : JSON.stringify(value)}`]).concat([
    "-c", `permissions.${REVIEW_PROFILE}.filesystem=${filesystem}`,
    "-c", `permissions.${REVIEW_PROFILE}.network.enabled=false`,
  ]);
}

/** Copy only provider settings and credentials, never sessions, hooks or arbitrary MCPs. */
export async function prepareReviewHome(source: string) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-review-")));
  try {
    const raw = await readFile(path.join(source, "config.toml"), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    const config = parse(raw);
    if (config.profile) throw new Error("review_isolation_named_profile_unsupported");
    const allowed = ["model", "model_provider", "model_providers", "model_reasoning_effort", "service_tier",
      "forced_login_method", "cli_auth_credentials_store", "chatgpt_base_url"];
    await writeFile(path.join(home, "config.toml"), stringify(Object.fromEntries(
      Object.entries(config).filter(([key]) => allowed.includes(key)))), { mode: 0o600 });
    const authPath = await realpath(path.join(source, "auth.json")).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (authPath) await writeFile(path.join(home, "auth.json"), await readFile(authPath), { mode: 0o600 });
    const scratch = path.join(home, "scratch");
    await mkdir(scratch, { mode: 0o700 });
    return { home, scratch, authPath };
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

export function assertReviewProfile(result: unknown, scratch: string) {
  const value = result as { activePermissionProfile?: { id?: string }; sandbox?: {
    type?: string; writableRoots?: string[]; networkAccess?: boolean;
    excludeTmpdirEnvVar?: boolean; excludeSlashTmp?: boolean;
  } };
  const sandbox = value?.sandbox;
  if (value?.activePermissionProfile?.id !== REVIEW_PROFILE || sandbox?.type !== "workspaceWrite"
    || sandbox.networkAccess !== false || sandbox.excludeTmpdirEnvVar !== true || sandbox.excludeSlashTmp !== true
    || sandbox.writableRoots?.length !== 1 || path.resolve(sandbox.writableRoots[0]!) !== path.resolve(scratch)) {
    throw new Error("review_isolation_profile_not_acknowledged");
  }
}

/** No turn/start: resolve the CLI default through the real native policy loader before inference. */
export async function verifyReviewDefault(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, scratch: string,
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>) {
  await new Promise<void>((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, [...args, "app-server"], { cwd, env, detached: grouped, stdio: ["pipe", "pipe", "pipe"] });
    let pending = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const kill = (signal: NodeJS.Signals) => {
        try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal); }
      };
      kill("SIGTERM");
      const killTimer = setTimeout(() => kill("SIGKILL"), 1_000);
      killTimer.unref();
      if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(killTimer);
        error ? reject(error) : resolve();
      } else child.once("close", () => {
        clearTimeout(killTimer);
        error ? reject(error) : resolve();
      });
    };
    const timer = setTimeout(() => finish(new Error("review_isolation_preflight_timeout")), 15_000);
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    child.on("error", error => finish(error));
    child.on("exit", () => finish(new Error("review_isolation_preflight_exited")));
    child.stdin.on("error", () => finish(new Error("review_isolation_preflight_pipe")));
    child.stderr.resume();
    child.stdout.on("data", (bytes: Buffer) => {
      pending += bytes.toString("utf8");
      if (Buffer.byteLength(pending) > 256 * 1024) return finish(new Error("review_isolation_preflight_limit"));
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.error) return finish(new Error("review_isolation_preflight_rejected"));
          if (message.id === 1) {
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "thread/start", params: { cwd, experimentalRawEvents: false, persistExtendedHistory: false } });
          } else if (message.id === 2) {
            assertReviewProfile(message.result, scratch); finish();
          }
        } catch { return finish(new Error("review_isolation_profile_not_acknowledged")); }
      }
    });
    const ready = child.pid && onSpawn ? onSpawn({ pid: child.pid, processGroupId: grouped ? child.pid : null, startedAt: new Date().toISOString() }) : Promise.resolve();
    void ready.then(() => {
      if (!settled) send({ id: 1, method: "initialize", params: { clientInfo: { name: "paperclip-review-preflight", version: "1" }, capabilities: { experimentalApi: true } } });
    }, error => finish(error instanceof Error ? error : new Error("review_isolation_spawn_rejected")));
  });
}
