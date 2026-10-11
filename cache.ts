/*
 * Request cache for the transport layer.
 *
 * No runtime URLs and no ambient globals, so the whole file runs under
 * `bun test`; the caller passes the fetcher in. One of these is kept per
 * resource — searches, songs, lyric pages, referents, Spotify lyrics — rather
 * than one shared map, so each is free to key and value itself.
 */

// A request the client never answers would otherwise hold the panel on
// "loading" for the rest of the track — and, since the promise is what the
// cache stores, poison that entry for the session. The bound turns a hang into
// a failure the panel can explain and a later ask can retry.
export const REQUEST_TIMEOUT = 8000; // ms

export type Cache<K, V> = {
	get(key: K): Promise<V>;
};

export interface CacheOptions {
	/**
	 * How long a fetched result is reused before the request is sent again, and
	 * how long it is kept at all: an entry past its ttl is dropped rather than
	 * sitting in memory for the rest of the session. Sizing by time rather than
	 * by entry count is enough here, because a listener does not work through
	 * hundreds of different songs inside the window.
	 */
	ttl: number;
	/** Injected so the expiry needs no real waiting. */
	now?: () => number;
}

type Entry<V> = { promise: Promise<V>; at: number };

export function createCache<K, V>(fetch: (key: K) => Promise<V>, { ttl, now = Date.now }: CacheOptions): Cache<K, V> {
	// The promise is stored rather than the result, so a request still in flight
	// is handed to whoever asks next instead of being sent again.
	const cached = new Map<K, Entry<V>>();

	// The call sits inside the executor, so a synchronous throw becomes a
	// rejection the cache can drop rather than an exception escaping get().
	function bounded(key: K): Promise<V> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`request timed out after ${REQUEST_TIMEOUT}ms`)), REQUEST_TIMEOUT);

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

			// Nothing empties the map on a timer, so the entries that went stale
			// are dropped here instead. Map keeps insertion order and a refreshed
			// key is re-inserted at the back, so the expired ones are at the front
			// and the walk stops at the first entry still inside its ttl.
			for (const [stale, entry] of cached) {
				if (now() - entry.at < ttl) break;
				cached.delete(stale);
			}

			const entry: Entry<V> = { promise: bounded(key), at: now() };

			// Re-inserting rather than overwriting, so refreshing a key also moves
			// it to the back of the queue the sweep above walks.
			cached.delete(key);
			cached.set(key, entry);

			// Attached before the promise can settle and never taken off: an
			// unawaited rejection would otherwise surface as an unhandled one, and
			// dropping the entry is what lets a later ask retry. A failed request
			// is usually transient — a 429, a cold proxy, one that hangs — so
			// retrying is right.
			entry.promise.catch(() => {
				if (cached.get(key) === entry) cached.delete(key);
			});

			return entry.promise;
		},
	};
}