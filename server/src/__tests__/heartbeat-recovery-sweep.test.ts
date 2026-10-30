import { describe, expect, it, vi } from "vitest";
import { createHeartbeatRecoverySweep } from "../services/heartbeat-recovery-sweep.js";

describe("independent heartbeat recovery queues", () => {
  it("continues healthy queues after an asynchronous failure and retries next tick", async () => {
    const failure = new Error("temporary connection failure");
    const failed = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const healthy = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const sweep = createHeartbeatRecoverySweep([["reap", failed], ["resume", healthy]], onError);
    await Promise.all(sweep());
    expect(onError).toHaveBeenCalledWith(failure, "reap");
    expect(healthy).toHaveBeenCalledTimes(1);
    await Promise.all(sweep());
    expect(failed).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("contains synchronous failures too", async () => {
    const healthy = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const sweep = createHeartbeatRecoverySweep([
      ["broken", () => { throw new Error("sync failure"); }], ["healthy", healthy],
    ], onError);
    await Promise.all(sweep());
    expect(healthy).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps a hanging queue single-flight while healthy queues keep advancing", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const hanging = vi.fn(() => pending);
    const healthy = vi.fn().mockResolvedValue(undefined);
    const sweep = createHeartbeatRecoverySweep([["hanging", hanging], ["healthy", healthy]], vi.fn());
    const first = sweep();
    await first[1];
    await Promise.all(sweep());
    expect(hanging).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledTimes(2);
    finish();
    await Promise.all(first);
    await Promise.all(sweep());
    expect(hanging).toHaveBeenCalledTimes(2);
  });
});
