// Unit tests for the request cache. cache.ts imports neither the runtime URLs
// nor the ambient globals, so it loads under plain `node --test` with the fetcher
// and the clock handed in.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createCache, REQUEST_TIMEOUT } from "../cache.ts";

const MINUTE = 60_000;
const TTL = 10 * MINUTE;

// A resolved sentinel cannot play this part: it would win every race.
const never = new Promise<never>(() => {});

/** A clock the test drives, so the expiry needs no real waiting. */
function clock(start = 1_000_000) {
	let time = start;
	return {
		now: () => time,
		advance: (ms: number) => {
			time += ms;
		},
	};
}

function countingFetcher() {
	const calls: string[] = [];

	return {
		calls,
		fetch: (key: string) => {
			calls.push(key);
			return Promise.resolve(`value:${key}`);
		},
	};
}

test("a request still in flight is shared rather than repeated", async () => {
	const { calls, fetch } = countingFetcher();
	const cache = createCache(fetch, { ttl: TTL });

	// Both asks land before anything settles.
	const inFlight = cache.get("a");
	const sameRequest = cache.get("a");

	assert.deepEqual(calls, ["a"]);
	assert.equal(await inFlight, await sameRequest);
});

test("a result is fetched again once its ttl has passed", async () => {
	const { calls, fetch } = countingFetcher();
	const time = clock();
	const cache = createCache(fetch, { ttl: TTL, now: time.now });

	await cache.get("a");

	// Still inside the window, so returning to the song costs nothing.
	time.advance(TTL - 1);
	await cache.get("a");
	assert.deepEqual(calls, ["a"], "a song heard again inside the ttl is free");

	time.advance(1);
	await cache.get("a");
	assert.deepEqual(calls, ["a", "a"], "past it the request is sent again");
});

test("an entry past its ttl is dropped instead of sitting in memory", async () => {
	// Nothing empties the map on a timer, so this is what keeps the caches from
	// growing for as long as the client stays open.
	const { calls, fetch } = countingFetcher();
	const time = clock();
	const cache = createCache(fetch, { ttl: TTL, now: time.now });

	for (let i = 0; i < 20; i++) {
		await cache.get(`key-${i}`);
		time.advance(TTL);
	}

	// One ttl after the last ask, everything before it is gone: only the newest
	// key can still be a hit, and the rest are refetched.
	const before = calls.length;
	await cache.get("key-0");
	assert.deepEqual(calls.slice(before), ["key-0"], "the oldest entry was swept, not kept");
	assert.equal(calls.length, before + 1);
});

test("a failure is not remembered, so the next ask retries", async () => {
	const calls: string[] = [];
	const cache = createCache(
		(key: string) => {
			calls.push(key);
			return calls.length === 1 ? Promise.reject(new Error("nope")) : Promise.resolve("recovered");
		},
		{ ttl: TTL },
	);

	await assert.rejects(cache.get("a"), /nope/);

	assert.equal(await cache.get("a"), "recovered");
	assert.deepEqual(calls, ["a", "a"]);
});

test("a request the client never answers is treated as a failure", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });

	const cache = createCache(() => new Promise<string>(() => {}), { ttl: TTL });

	const pending = cache.get("a");
	t.mock.timers.tick(REQUEST_TIMEOUT);

	// Without a bound this would sit loading for the rest of the track.
	await assert.rejects(Promise.race([pending, never]), /timed out/);
});

test("a hung request is dropped, so a later ask starts fresh", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });

	const calls: string[] = [];
	const cache = createCache(
		(key: string) => {
			calls.push(key);
			return calls.length === 1 ? new Promise<string>(() => {}) : Promise.resolve("recovered");
		},
		{ ttl: TTL },
	);

	const hung = cache.get("a");
	t.mock.timers.tick(REQUEST_TIMEOUT);
	await assert.rejects(Promise.race([hung, never]), /timed out/);

	// The entry has to be gone, or a track that hung once could never recover.
	assert.equal(await cache.get("a"), "recovered");
	assert.deepEqual(calls, ["a", "a"]);
});

test("a failure nobody awaits does not surface as an unhandled rejection", async () => {
	const seen: unknown[] = [];
	const onUnhandled = (reason: unknown) => seen.push(reason);
	process.on("unhandledRejection", onUnhandled);

	try {
		// The retry-on-rejection handler is the only thing attached to a request
		// whose caller dropped the promise; without it this would surface.
		createCache(() => Promise.reject(new Error("nope")), { ttl: TTL }).get("a");
		await new Promise((resolve) => setTimeout(resolve, 10));
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}

	assert.deepEqual(seen, []);
});
