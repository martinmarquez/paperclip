type RecoveryStep = readonly [name: string, run: () => Promise<unknown>];

/** A failed or hanging recovery queue must not stop the other durable queues. */
export function createHeartbeatRecoverySweep(
  steps: readonly RecoveryStep[],
  onError: (error: unknown, queue: string) => void,
) {
  const running = new Set<string>();
  return (): Promise<void>[] => steps.flatMap(([name, run]) => {
    if (running.has(name)) return [];
    running.add(name);
    return [Promise.resolve().then(run)
      .then(() => undefined)
      .catch(error => onError(error, name))
      .finally(() => { running.delete(name); })];
  });
}
