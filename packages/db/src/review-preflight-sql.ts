import { withDedicatedDbConnection, type Db } from "./client.js";

// postgres.js 3.4.9's public cancel() discards this promise. Observe failure without an unhandled rejection.
export async function cancelPreflightQuery(query: object): Promise<void> {
  const cancel: unknown = Reflect.get(query, "canceller");
  if (typeof cancel !== "function") return;
  Reflect.set(query, "canceller", null);
  try { await cancel(query); }
  catch { /* The server statement deadline and dedicated-connection close remain the backstops. */ }
}

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
      const cancel = () => { void cancelPreflightQuery(pending); };
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
        const cancelSettleMs = Math.min(250, Math.max(1, Math.floor(options.timeoutMs / 4)));
        const deadline = performance.now() + options.timeoutMs;
        let forceClose: ReturnType<typeof setTimeout> | undefined;
        const abort = () => {
          if (controller.signal.aborted) return;
          controller.abort();
          // Give PostgreSQL's cancel response time to settle before closing its socket.
          forceClose = setTimeout(() => { void dedicated.$client.end({ timeout: 0 }).catch(() => {}); }, cancelSettleMs);
        };
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
        const timer = setTimeout(abort, options.timeoutMs);
        try {
          const boxed = await dedicated.$client.begin(async (tx) => {
            if (controller.signal.aborted) throw new Error("preflight_sql_cancelled");
            // A closed socket alone does not interrupt a running backend query.
            const remaining = Math.floor(deadline - performance.now() - cancelSettleMs);
            if (remaining <= 0) throw new Error("preflight_sql_cancelled");
            await tx`SELECT set_config('statement_timeout', ${String(remaining)}, true)`;
            const result = await work(executor(tx, controller.signal));
            if (controller.signal.aborted || performance.now() >= deadline) throw new Error("preflight_sql_cancelled");
            return { value: result };
          });
          return boxed.value;
        } finally {
          clearTimeout(timer);
          if (forceClose) clearTimeout(forceClose);
          options.signal.removeEventListener("abort", abort);
        }
      });
    },
  };
}
