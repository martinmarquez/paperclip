import { withDedicatedDbConnection, type Db } from "./client.js";

export interface PreflightSqlExecutor {
  query<T extends Record<string, unknown>>(text: string, params?: readonly unknown[], signal?: AbortSignal): Promise<{ rows: T[] }>;
}

export interface PreflightSqlDatabase extends PreflightSqlExecutor {
  transaction<T>(work: (tx: PreflightSqlExecutor) => Promise<T>, options: { signal: AbortSignal; timeoutMs: number }): Promise<T>;
}

function parameters(values: readonly unknown[]) {
  return values.map((value) => {
    // Drizzle makes the shared postgres.js timestamp/JSON serializers transparent.
    if (value instanceof Date) return value.toISOString();
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "object") return JSON.stringify(value);
    throw new Error("preflight_sql_parameter_invalid");
  });
}

function executor(client: Pick<Db["$client"], "unsafe">, defaultSignal?: AbortSignal): PreflightSqlExecutor {
  return {
    async query<T extends Record<string, unknown>>(text: string, params: readonly unknown[] = [], signal?: AbortSignal) {
      if (signal?.aborted || defaultSignal?.aborted) throw new Error("preflight_sql_cancelled");
      const pending = client.unsafe<T[]>(text, parameters(params));
      const cancel = () => {
        try { pending.cancel(); }
        catch { /* The transaction deadline also closes its dedicated connection. */ }
      };
      signal?.addEventListener("abort", cancel, { once: true });
      defaultSignal?.addEventListener("abort", cancel, { once: true });
      try {
        const rows = await pending;
        if (signal?.aborted || defaultSignal?.aborted) throw new Error("preflight_sql_cancelled");
        return { rows: Array.from(rows) };
      } finally {
        signal?.removeEventListener("abort", cancel);
        defaultSignal?.removeEventListener("abort", cancel);
      }
    },
  };
}

// Uses an existing native client; never opens a new database or applies schema.
export function createReviewPreflightSqlDatabase(db: Db): PreflightSqlDatabase {
  return {
    ...executor(db.$client),
    async transaction<T>(work: (tx: PreflightSqlExecutor) => Promise<T>, options: { signal: AbortSignal; timeoutMs: number }) {
      if (options.signal.aborted) throw new Error("preflight_sql_cancelled");
      return withDedicatedDbConnection(db, async (dedicated) => {
        const controller = new AbortController();
        const abort = () => {
          controller.abort();
          // End only this operation's connection, including a pending BEGIN/COMMIT.
          void dedicated.$client.end({ timeout: 0 }).catch(() => {});
        };
        options.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, options.timeoutMs);
        try {
          const boxed = await dedicated.$client.begin(async (tx) => {
            if (controller.signal.aborted) throw new Error("preflight_sql_cancelled");
            const result = await work(executor(tx, controller.signal));
            if (controller.signal.aborted) throw new Error("preflight_sql_cancelled");
            return { value: result };
          });
          return boxed.value;
        } finally {
          clearTimeout(timer);
          options.signal.removeEventListener("abort", abort);
        }
      });
    },
  };
}
