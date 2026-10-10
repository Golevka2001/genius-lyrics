/*
 * Request cache for the transport layer.
 *
 * No runtime URLs and no ambient globals, so the whole file runs under
 * `bun test`; the caller passes the fetcher in. One of these is kept per
 * resource — searches, songs, lyric pages, referents, Spotify lyrics — rather
 * than one shared map, so each is free to key and value itself.
 */

export type Cache<K, V> = {
	get(key: K): Promise<V>;
};

export function createCache<K, V>(fetch: (key: K) => Promise<V>): Cache<K, V> {
	// The promise is stored rather than the result, so a request still in flight
	// is handed to whoever asks next instead of being sent again. Nothing is
	// dropped: a listening session touches a bounded set of tracks, and the point
	// of the cache is that returning to one costs nothing the second time.
	const cached = new Map<K, Promise<V>>();

	return {
		get(key) {
			const held = cached.get(key);
			if (held) return held;

			const request = fetch(key);

			// Attached before the promise can settle and never taken off: an
			// unawaited rejection would otherwise surface as an unhandled one, and
			// dropping the entry is what lets a later ask retry. A failed request
			// is usually transient — a 429, a cold proxy — so retrying is right.
			request.catch(() => {
				if (cached.get(key) === request) cached.delete(key);
			});

			cached.set(key, request);

			return request;
		},
	};
}