// Unit tests for the panel's load chain. panel.ts imports no runtime URL and no
// ambient client, so the transport is handed in and the ordering can be driven
// step by step — which is the whole point of splitting it out of mod.tsx.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createPanel, type TrackItem, type Transport } from "../panel.ts";
import type { Annotation, GeniusSong, LyricLine, SongHit } from "../logic.ts";

const hit: SongHit = { id: 1, title: "Creep", url: "https://genius.com/x", artist: "Radiohead", annotationCount: 1, translation: false };

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

const song: GeniusSong = { id: 1, title: "Creep", url: "https://genius.com/x", annotationCount: 1, description: "" };

// A transport that records what it was asked and answers from a table of
// per-key promises, so a test can hold a request open and release it later.
//
// Every track's referents are prefixed with its own title, because a stale
// answer is only detectable when the two tracks do not share ids.
function harness(overrides: Partial<Transport> = {}) {
	const calls: string[] = [];
	const gates = new Map<string, { promise: Promise<void>; release: () => void }>();

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
			return [{ ...hit, title, url: `https://genius.com/${title}` }];
		},
		fetchSong: async () => {
			calls.push("song");
			return song;
		},
		fetchLyrics: async (songUrl) => {
			calls.push(`lyrics:${songUrl}`);
			const prefix = songUrl.split("/").pop();
			return [lyricLine("a line", [`${prefix}-1`]), lyricLine("another", [`${prefix}-2`])];
		},
		fetchSpotifyLyrics: async () => {
			calls.push("timing");
			return null;
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

test("notes arrive without the panel leaving the ready state", async () => {
	const h = harness();
	const panel = createPanel(h.transport);
	const states: string[] = [];
	panel.subscribe(() => states.push(panel.state.state));

	await panel.load(track("one"));

	assert.equal(states[0], "loading", "the first paint asks for the track");
	assert.ok(
		states.slice(1).every((entry) => entry === "ready"),
		`every repaint after the first is ready, got ${JSON.stringify(states)}`,
	);
	assert.deepEqual(shownIds(panel), ["one-1", "one-2"], "both notes landed on their own lines");
	assert.equal(panel.state.track?.lines[0].resolved, true);
});

test("a track change stops the note pass that was still running", async () => {
	const h = harness();
	const panel = createPanel(h.transport);

	// The first note is held open, so the pass is mid-flight when the user skips.
	h.hold("one-1");
	const first = panel.load(track("one"));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.ok(h.calls.some((call) => call.startsWith("notes:one-")), "the pass started");

	await panel.load(track("two"));
	assert.equal(panel.state.track?.title, "two", "the second track is on screen");

	// The first pass is still parked on its held note, so releasing it is what
	// would carry the old track's answer back in.
	h.gates.get("one-1")?.release();
	await first;
	assert.deepEqual(shownIds(panel), ["two-1", "two-2"], "only the current track's notes are showing");
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

test("unsubscribing stops the notifications", async () => {
	const h = harness();
	const panel = createPanel(h.transport);
	let notifications = 0;
	const off = panel.subscribe(() => notifications++);

	await panel.load(track("one"));
	const seen = notifications;
	assert.ok(seen > 0, "the load notified while subscribed");

	off();
	await panel.load(track("two"));
	assert.equal(notifications, seen, "nothing arrives after unsubscribing");
});