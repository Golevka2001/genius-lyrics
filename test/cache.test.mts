// Unit tests for the request cache. cache.ts imports neither the runtime URLs
// nor the ambient globals, so it loads under plain `bun test` with the fetcher
// handed in.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createCache, REQUEST_TIMEOUT } from "../cache.ts";

// A resolved sentinel cannot play this part: it would win every race.
const never = new Promise<never>(() => {});

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

test("the same key is fetched once however often it is asked for", async () => {
	const { calls, fetch } = countingFetcher();
	const cache = createCache(fetch);

	const first = await cache.get("a");
	const second = await cache.get("a");

	assert.deepEqual(calls, ["a"]);
	assert.equal(second, first);
});

test("a request still in flight is shared rather than repeated", async () => {
	const { calls, fetch } = countingFetcher();
	const cache = createCache(fetch);

	// Both asks land before anything settles.
	const inFlight = cache.get("a");
	const sameRequest = cache.get("a");

	assert.deepEqual(calls, ["a"]);
	assert.equal(await inFlight, await sameRequest);
});

test("a result is still there after the request has settled", async () => {
	const { calls, fetch } = countingFetcher();
	const cache = createCache(fetch);

	await cache.get("a");
	await new Promise((resolve) => setTimeout(resolve, 0)); // let it settle
	await cache.get("a");

	assert.deepEqual(calls, ["a"]);
});

test("different keys are cached apart from each other", async () => {
	const { calls, fetch } = countingFetcher();
	const cache = createCache(fetch);

	await cache.get("a");
	await cache.get("b");
	await cache.get("a");

	assert.deepEqual(calls, ["a", "b"]);
});

test("a failure is not remembered, so the next ask retries", async () => {
	const calls: string[] = [];
	const cache = createCache((key: string) => {
		calls.push(key);
		return calls.length === 1 ? Promise.reject(new Error("nope")) : Promise.resolve("recovered");
	});

	await assert.rejects(cache.get("a"), /nope/);

	assert.equal(await cache.get("a"), "recovered");
	assert.deepEqual(calls, ["a", "a"]);
});

test("a request the client never answers is treated as a failure", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });

	const cache = createCache(() => new Promise<string>(() => {}));

	const pending = cache.get("a");
	t.mock.timers.tick(REQUEST_TIMEOUT);

	// Without a bound this would sit loading for the rest of the track.
	await assert.rejects(Promise.race([pending, never]), /timed out/);
});

test("a hung request is dropped, so a later ask starts fresh", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });

	const calls: string[] = [];
	const cache = createCache((key: string) => {
		calls.push(key);
		return calls.length === 1 ? new Promise<string>(() => {}) : Promise.resolve("recovered");
	});

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
		createCache(() => Promise.reject(new Error("nope"))).get("a");
		await new Promise((resolve) => setTimeout(resolve, 10));
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}

	assert.deepEqual(seen, []);
});

test("nothing is dropped over a long session", async () => {
	const { calls, fetch } = countingFetcher();
	const cache = createCache(fetch);

	for (let i = 0; i < 500; i++) await cache.get(`key-${i}`);

	// Even the first keys of the session are still there, so looping a long
	// playlist costs one fetch per track rather than one per play.
	await cache.get("key-0");
	await cache.get("key-250");

	assert.equal(calls.length, 500);
});
