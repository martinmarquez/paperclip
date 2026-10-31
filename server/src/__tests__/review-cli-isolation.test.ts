import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { buildCodexExecArgs } from "../../../packages/adapters/codex-local/src/server/codex-args.js";
import { REVIEW_PROFILE, reviewIsolationArgs, prepareReviewHome, assertReviewProfile,
  verifyReviewDefault } from "../../../packages/adapters/codex-local/src/server/review-isolation.js";
import { reviewTaskRequest, callReviewTaskTool } from "../services/review-task-tools.js";
import { execute } from "@paperclipai/adapter-codex-local/server";
import { cancelPreflightQuery } from "../../../packages/db/src/review-preflight-sql.js";

describe("local CLI review isolation", () => {
  it("denies legacy overrides, resume, search and default bypass", () => {
    const args = buildCodexExecArgs({ reviewReadOnly: true, search: true,
      dangerouslyBypassApprovalsAndSandbox: true }, { networkAccess: false }).args;
    expect(args).toEqual(["exec", "--json", "-"]);
    expect(() => buildCodexExecArgs({ reviewReadOnly: true, extraArgs: ["--yolo"] })).toThrow(/controlled/);
    expect(() => buildCodexExecArgs({ reviewReadOnly: true }, { resumeSessionId: "unsafe" })).toThrow(/fresh/);
    const configArgs = reviewIsolationArgs("/source", "/private/home", "/private/home/scratch");
    expect(configArgs).toContain(`default_permissions="${REVIEW_PROFILE}"`);
    expect(configArgs).toContain(`permissions.${REVIEW_PROFILE}.network.enabled=false`);
    expect(configArgs).toContain("features.code_mode=false");
    expect(configArgs.join(" ")).not.toMatch(/sandbox_mode|network.enabled=true|inherit="all"/);
    expect(() => reviewIsolationArgs("/", "/home", "/scratch")).toThrow(/root/);
  });

  it("copies provider choice but drops all ambient execution permissions and state", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "review-source-"));
    let prepared: Awaited<ReturnType<typeof prepareReviewHome>> | undefined;
    try {
      await writeFile(path.join(source, "config.toml"), 'model="same-model"\nsandbox_mode="danger-full-access"\n[mcp_servers.unsafe]\ncommand="arbitrary"\n');
      await writeFile(path.join(source, "auth.json"), '{"OPENAI_API_KEY":"fixture"}');
      await writeFile(path.join(source, "sessions.sqlite"), "must not copy");
      prepared = await prepareReviewHome(source);
      expect(parse(await readFile(path.join(prepared.home, "config.toml"), "utf8"))).toEqual({ model: "same-model" });
      expect((await stat(path.join(prepared.home, "auth.json"))).mode & 0o777).toBe(0o600);
      await expect(stat(path.join(prepared.home, "sessions.sqlite"))).rejects.toThrow();
      expect(prepared.authPath).toBe(await realpath(path.join(source, "auth.json")));
    } finally {
      await rm(source, { recursive: true, force: true });
      if (prepared) await rm(prepared.home, { recursive: true, force: true });
    }
  });

  it("requires the canonical default profile and scratch-only native summary", () => {
    const proof = { activePermissionProfile: { id: REVIEW_PROFILE }, sandbox: {
      type: "workspaceWrite", writableRoots: ["/scratch"], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true } };
    expect(() => assertReviewProfile(proof, "/scratch")).not.toThrow();
    expect(() => assertReviewProfile({ ...proof, activePermissionProfile: {} }, "/scratch")).toThrow(/acknowledged/);
    expect(() => assertReviewProfile({ ...proof, sandbox: { ...proof.sandbox, writableRoots: ["/source"] } }, "/scratch")).toThrow();
    expect(() => assertReviewProfile({ ...proof, sandbox: { ...proof.sandbox, networkAccess: true } }, "/scratch")).toThrow();
  });

  it("executes the real CLI adapter only after a no-turn native preflight, using a fresh private home", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "review-execute-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const capture = path.join(root, "capture.json");
    const command = path.join(root, "codex");
    await mkdir(home); await mkdir(workspace);
    await writeFile(path.join(home, "auth.json"), '{"OPENAI_API_KEY":"fixture"}');
    await writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const argv = process.argv.slice(2);
if (argv.includes('app-server')) {
  readline.createInterface({input:process.stdin}).on('line', line => {
    const m=JSON.parse(line);
    if(m.method==='turn/start') process.exit(90);
    if(m.id===1) console.log(JSON.stringify({id:1,result:{}}));
    if(m.id===2) console.log(JSON.stringify({id:2,result:{activePermissionProfile:{id:${JSON.stringify(REVIEW_PROFILE)}},sandbox:{type:'workspaceWrite',writableRoots:[process.env.CODEX_HOME+'/scratch'],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}}}));
  });
} else if(argv.includes('exec')) {
  const prompt=fs.readFileSync(0,'utf8');
  fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv,prompt,home:process.env.CODEX_HOME,config:fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8')}));
  console.log(JSON.stringify({type:'thread.started',thread_id:'new-review-session'}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
}
`, { mode: 0o700 });
    try {
      const config = { engine: "cli", reviewReadOnly: true, command, cwd: workspace,
        env: { CODEX_HOME: home }, promptTemplate: "Review the source" };
      const result = await execute({ runId: "review-test", agent: { id: "reviewer", companyId: "company",
        name: "reviewer", adapterType: "codex_local", adapterConfig: config }, config,
        runtime: { sessionId: "old-writable-session", sessionParams: { cwd: workspace }, sessionDisplayId: null, taskKey: null },
        context: {}, authToken: "fixture-run-token", runtimeMcp: { getServers: () => [{
          name: "Paperclip review task", url: "http://localhost/api/mcp/project-tools", token: "fixture-run-token", connectionId: "review" }] },
        onLog: async () => {} });
      expect(result.exitCode).toBe(0);
      const captured = JSON.parse(await readFile(capture, "utf8"));
      expect(captured.home).not.toBe(home);
      expect(captured.argv).not.toContain("resume");
      expect(captured.argv.join(" ")).not.toContain("sandbox_mode");
      expect(captured.config).toContain("paperclip-review-task");
      expect(captured.prompt).toContain("Never attempt API calls from the shell");
      await expect(stat(captured.home)).rejects.toThrow();
      await expect(verifyReviewDefault(command, [], workspace, { ...process.env, CODEX_HOME: "/wrong" }, "/scratch")).rejects.toThrow(/acknowledged/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("review task gateway", () => {
  it("observes the pinned driver's real cancellation promise exactly once", async () => {
    const canceller = vi.fn().mockRejectedValue(new Error("cancel connection unavailable"));
    const query = { cancel: vi.fn(() => { throw new Error("public cancel discards the promise"); }), canceller };
    await expect(cancelPreflightQuery(query)).resolves.toBeUndefined();
    await expect(cancelPreflightQuery(query)).resolves.toBeUndefined();
    expect(canceller).toHaveBeenCalledTimes(1);
    expect(query.cancel).not.toHaveBeenCalled();
    expect(query.canceller).toBeNull();
  });
  it("reports non-JSON proxy errors and returns MCP-compatible comment arrays", async () => {
    const input = { arguments: { operation: "get_comments" }, issueId: "own", agentId: "reviewer",
      runId: "run", apiUrl: "http://localhost/api", token: "fixture-token" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      fetchMock.mockResolvedValueOnce(new Response("<h1>Bad gateway</h1>", { status: 502 }));
      await expect(callReviewTaskTool(input)).rejects.toThrow(/502/);
      fetchMock.mockResolvedValueOnce(new Response("null", { status: 403 }));
      await expect(callReviewTaskTool(input)).rejects.toThrow(/403/);
      fetchMock.mockResolvedValueOnce(new Response('[{"body":"review"}]', { status: 200 }));
      expect(await callReviewTaskTool(input)).toEqual({ items: [{ body: "review" }] });
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { "X-Paperclip-Run-Id": "run" } });
    } finally { vi.unstubAllGlobals(); }
  });
  it("binds all paths and mutation identities on the server and keeps revision control", () => {
    expect(reviewTaskRequest({ operation: "checkout" }, "own", "reviewer")).toMatchObject({
      path: "/issues/own/checkout", body: { agentId: "reviewer" } });
    expect(reviewTaskRequest({ operation: "save_document", key: "review", title: "Review", body: "evidence", baseRevisionId: null }, "own", "reviewer"))
      .toMatchObject({ path: "/issues/own/documents/review", body: { baseRevisionId: null, format: "markdown" } });
    for (const args of [{ operation: "get_task", issueId: "other" }, { operation: "create_task" },
      { operation: "get_document", key: "../secret" }, { operation: "set_status", status: "todo", comment: "wake" }]) {
      expect(() => reviewTaskRequest(args, "own", "reviewer")).toThrow();
    }
  });
});
