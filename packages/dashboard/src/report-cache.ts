/** Briefly reuse identical reports, including requests already in flight. */
export function reportCache(ttl = 10_000, limit = 64) {
  const entries = new Map<string, { until: number; result: Promise<unknown>; value?: unknown }>();
  return {
    clear: () => entries.clear(),
    peek<T>(key: string): T | undefined { return entries.get(key)?.value as T | undefined; },
    read<T>(key: string, load: () => Promise<T>): Promise<T> {
      const found = entries.get(key);
      if (found && found.until > Date.now()) return found.result as Promise<T>;
      entries.delete(key);
      const entry: { until: number; result: Promise<unknown>; value?: unknown } = { until: Infinity, result: Promise.resolve().then(load) as Promise<unknown>, value: found?.value };
      entries.set(key, entry);
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
      entry.result = entry.result.then((value) => {
        entry.value = value;
        entry.until = Date.now() + ttl;
        return value;
      }, (error: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      return entry.result as Promise<T>;
    },
  };
}
