// Unit tests for the panel's load chain. panel.ts imports no runtime URL and no
// ambient client, so the transport is handed in and the ordering can be driven
// step by step — which is the whole point of splitting it out of mod.tsx.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createPanel, type TrackItem, type Transport } from "../panel.ts";
import type { Annotation, GeniusSong, LyricLine, SongHit } from "../logic.ts";

const hit: SongHit = { id: 1, title: "Creep", url: "https://genius.com/x", artist: "Radiohead", annotationCount: 1 };

const lyricLine = (text: string, referentIds: string[] = []): LyricLine => ({ text, referentIds });

const note = (id: string): Annotation => ({
	referentId: id,
	fragment: id,
	text: `a note about ${id}`,
	blocks: [],
	verified: false,
	source: "referent",
	authors: [],
});

const song: GeniusSong = { id: 1, title: "Creep", url: "https://genius.com/x", annotationCount: 1, translationIds: [], description: "" };

// A transport that records what it was asked and answers from a table of
// per-key promises, so a test can hold a request open and release it later.
//
// Every track's referents are prefixed with its own title, because a stale
// answer is only detectable when the two tracks do not share ids.
function harness(overrides: Partial<Transport> = {}) {
	const calls: string[] = [];
	const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
	/** The track the last search was for, which the song answer echoes back. */
	let current = "";

	/** Leaves `id` unanswered until `release()` is called on it. */
	const hold = (id: string) => {
		let open = () => {};
		const promise = new Promise<void>((resolve) => {
			open = resolve;
		});
		gates.set(id, { promise, release: open });
	};

	const transport: Transport = {
		searchSong: async (title) => {
			calls.push(`search:${title}`);
			current = title;
			return [{ ...hit, title, url: `https://genius.com/${title}` }];
		},
		fetchOriginalSong: async (id) => {
			calls.push("song");
			// The page the panel reads comes from here rather than from the search
			// hit, so the answer carries the track's own url: the referents below are
			// named after it, and two tracks sharing one would hide a stale repaint.
			return { ...song, id, title: current, url: `https://genius.com/${current}` };
		},
		fetchLyrics: async (songUrl) => {
			calls.push(`lyrics:${songUrl}`);
			const prefix = songUrl.split("/").pop();
			return [lyricLine("a line", [`${prefix}-1`]), lyricLine("another", [`${prefix}-2`])];
		},
		fetchSpotifyLyrics: async () => {
			calls.push("timing");
			// A null default here hid the wrapper being passed where a list is expected.
			return {
				synced: true,
				lines: [
					{ text: "a line", startTimeMs: 1000 },
					{ text: "another", startTimeMs: 4000 },
				],
			};
		},
		fetchAnnotations: async (ids, { signal, onBatch } = {}) => {
			calls.push(`notes:${ids.join(",")}`);
			const notes = new Map<string, Annotation>();
			const settled: string[] = [];
			for (const id of ids) {
				const gate = gates.get(id);
				if (gate) await gate.promise;
				if (signal?.aborted) return { notes, settled };
				notes.set(id, note(id));
				settled.push(id);
				onBatch?.({ notes: new Map([[id, note(id)]]), settled: [id] });
			}
			return { notes, settled };
		},
		detectFailure: (error) => String((error as Error)?.message ?? error),
		warn: () => {},
		...overrides,
	};

	return { calls, gates, hold, transport };
}

/** The line of every ready paint, so ordering can be asserted. */
function paintedLines(panel: ReturnType<typeof createPanel>) {
	return panel.state.track?.lines.filter((line) => line.annotated).length ?? 0;
}

const track = (name: string): TrackItem => ({ uri: `spotify:track:${name}`, name, artists: [{ name: "Radiohead" }] });

/** Every note id the panel is currently showing. */
const shownIds = (panel: ReturnType<typeof createPanel>) =>
	panel.state.track?.lines.flatMap((line) => line.notes.map((entry) => entry.referentId)) ?? [];

test("the lyrics are painted before any note has arrived", async () => {
	const h = harness();
	const panel = createPanel(h.transport);

	// Hold both notes so the first paint is the only paint that happens.
	h.hold("one-1");
	h.hold("one-2");
	const loading = panel.load(track("one"));
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(panel.state.state, "ready", "the lyrics are readable while the notes are still coming");
	assert.equal(panel.state.track?.lines.length, 2);
	assert.equal(paintedLines(panel), 2, "an anchor alone is enough to offer the note");
	assert.deepEqual(shownIds(panel), [], "and nothing is on a line yet");

	h.gates.get("one-1")?.release();
	h.gates.get("one-2")?.release();
	await loading;
});

test("an answer that lands after the track changed is dropped", async () => {
	const h = harness();
	const panel = createPanel(h.transport);

	h.hold("one-1");
	const first = panel.load(track("one"));
	await new Promise((resolve) => setTimeout(resolve, 0));

	// The listener skips; the held request answers only afterwards.
	await panel.load(track("two"));
	h.gates.get("one-1")?.release();
	await first;

	assert.equal(panel.state.track?.title, "two");
	assert.deepEqual(shownIds(panel), ["two-1", "two-2"], "a stale repaint would have put one-1 back");
});

test("a track Genius does not have reports no lyrics rather than failing", async () => {
	const h = harness({ searchSong: async () => [] });
	const panel = createPanel(h.transport);

	await panel.load(track("one"));

	assert.equal(panel.state.state, "no-genius");
	assert.equal(panel.state.track?.lines.length, 0);
});

test("a note that arrives after the track changed does not repaint", async () => {
	// The realistic stale path: the batch was already past its own abort check
	// when the listener skipped, so it answers anyway. Nothing but the panel's own
	// generation check stands between that answer and the screen.
	const h = harness({
		fetchAnnotations: async (ids, { onBatch } = {}) => {
			const notes = new Map<string, Annotation>();
			const settled: string[] = [];
			for (const id of ids) {
				const gate = h.gates.get(id);
				if (gate) await gate.promise;
				notes.set(id, note(id));
				settled.push(id);
				onBatch?.({ notes: new Map([[id, note(id)]]), settled: [id] });
			}
			return { notes, settled };
		},
	});
	const panel = createPanel(h.transport);

	h.hold("one-1");
	const first = panel.load(track("one"));
	await new Promise((resolve) => setTimeout(resolve, 0));

	await panel.load(track("two"));
	assert.deepEqual(shownIds(panel), ["two-1", "two-2"]);

	// The abandoned batch answers last, with the previous track's note in hand.
	h.gates.get("one-1")?.release();
	await first;

	assert.equal(panel.state.track?.title, "two", "the answer must not replace the track either");
	assert.deepEqual(shownIds(panel), ["two-1", "two-2"], "a stale repaint would have put one-1 back");
});

test("no item at all is reported as missing, not as a failure", async () => {
	const h = harness();
	const panel = createPanel(h.transport);

	await panel.load(undefined);

	assert.equal(panel.state.state, "no-genius");
	assert.equal(h.calls.length, 0, "nothing is fetched for a track that is not there");
});

test("a transport failure is reported with its reason", async () => {
	const h = harness({
		searchSong: async () => {
			throw new Error("Genius rate limit reached (429). Try again in a moment.");
		},
	});
	const panel = createPanel(h.transport);

	await panel.load(track("one"));

	assert.equal(panel.state.state, "failed");
	assert.match(String(panel.state.error), /rate limit/);
});

test("retry asks for the same track again", async () => {
	let attempts = 0;
	const h = harness({
		searchSong: async (title) => {
			attempts++;
			if (attempts === 1) throw new Error("Could not reach Genius.");
			return [{ ...hit, title, url: `https://genius.com/${title}` }];
		},
	});
	const panel = createPanel(h.transport);

	await panel.load(track("one"));
	assert.equal(panel.state.state, "failed");

	await panel.retry();

	assert.equal(attempts, 2, "a retry must re-ask rather than replay the failure");
	assert.equal(panel.state.state, "ready");
});

test("retry keeps the track it failed on", async () => {
	const asked: string[] = [];
	const h = harness({
		searchSong: async (title) => {
			asked.push(title);
			throw new Error("Could not reach Genius.");
		},
	});
	const panel = createPanel(h.transport);

	await panel.load(track("one"));
	await panel.retry();

	assert.deepEqual(asked, ["one", "one"], "the second attempt must be for the same track");
});

test("Spotify's synced lyrics become the timing axis", async () => {
	// The payload is a wrapper; applyTiming wants the lines.
	const h = harness();
	const panel = createPanel(h.transport);

	await panel.load(track("one"));

	const starts = panel.state.track?.lines.map((line) => line.startTimeMs);
	assert.deepEqual(starts, [1000, 4000]);
});

test("unsynced Spotify lyrics leave the lines untimed", async () => {
	const h = harness({
		fetchSpotifyLyrics: async () => ({ synced: false, lines: [{ text: "a line", startTimeMs: 1000 }] }),
	});
	const panel = createPanel(h.transport);

	await panel.load(track("one"));

	assert.equal(panel.state.state, "ready");
	assert.deepEqual(
		panel.state.track?.lines.map((line) => line.startTimeMs),
		[undefined, undefined],
	);
});

test("the chosen hit is the one matching title and artist, not the first", async () => {
	const other = { ...hit, id: 2, title: "Creep", artist: "Radiohead (Cover Band)" };
	// The page read is the resolved song's, so answering per id is what records
	// which of the two hits was chosen.
	const h = harness({
		searchSong: async () => [other, hit],
		fetchOriginalSong: async (id) => ({ ...song, id, url: `https://genius.com/${id}` }),
	});
	const panel = createPanel(h.transport);

	await panel.load(track("Creep"));

	assert.ok(
		h.calls.includes(`lyrics:https://genius.com/${hit.id}`),
		`expected the matching hit's page, got ${JSON.stringify(h.calls)}`,
	);
	assert.ok(!h.calls.includes(`lyrics:https://genius.com/${other.id}`), "the cover band's page was read");
});

test("a page with no readable lyrics keeps the track's name for the message", async () => {
	const h = harness({ fetchLyrics: async () => [] });
	const panel = createPanel(h.transport);

	await panel.load(track("Creep"));

	assert.equal(panel.state.state, "no-genius");
	assert.equal(panel.state.track?.title, "Creep");
});

test("toggle opens one line and closes it again", async () => {
	const h = harness();
	const panel = createPanel(h.transport);
	await panel.load(track("one"));

	assert.equal(panel.openLine, null);
	panel.toggle(0);
	assert.equal(panel.openLine, 0);
	panel.toggle(0);
	assert.equal(panel.openLine, null);
	panel.toggle(1);
	assert.equal(panel.openLine, 1, "opening another line moves the popover");
});

test("loading a new track closes whatever note was open", async () => {
	const h = harness();
	const panel = createPanel(h.transport);
	await panel.load(track("one"));
	panel.toggle(0);

	await panel.load(track("two"));

	assert.equal(panel.openLine, null, "a popover from the previous track must not survive the change");
});
