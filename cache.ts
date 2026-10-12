/** Promise cache with TTL, timeout, and retry-on-failure behavior. */

export const REQUEST_TIMEOUT = 8000; // ms

export type Cache<K, V> = {
	get(key: K): Promise<V>;
};

export type CacheOptions = {
	ttl: number;
	now?: () => number;
};

type Entry<V> = { promise: Promise<V>; at: number };

export function createCache<K, V>(fetch: (key: K) => Promise<V>, { ttl, now = Date.now }: CacheOptions): Cache<K, V> {
	const cached = new Map<K, Entry<V>>();

	function bounded(key: K): Promise<V> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`request timed out after ${REQUEST_TIMEOUT}ms`)),
				REQUEST_TIMEOUT,
			);

			fetch(key).then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	}

	return {
		get(key) {
			const held = cached.get(key);
			if (held && now() - held.at < ttl) return held.promise;

			for (const [stale, entry] of cached) {
				if (now() - entry.at < ttl) break;
				cached.delete(stale);
			}

			const entry: Entry<V> = { promise: bounded(key), at: now() };
			cached.delete(key);
			cached.set(key, entry);

			entry.promise.catch(() => {
				if (cached.get(key) === entry) cached.delete(key);
			});

			return entry.promise;
		},
	};
}
