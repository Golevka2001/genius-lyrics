import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTiming, buildTrackView, hasTimeline, type LineView } from "../view.ts";
import type { Annotation, LyricLine } from "../logic.ts";

const note = (id: string, text: string, verified = false): Annotation => ({
	referentId: id,
	fragment: id,
	text,
	verified,
	source: "referent",
	authors: [],
	blocks: [],
});

const line = (text: string, referentIds: string[] = []): LyricLine => ({ text, referentIds });

// An unannotated line, for the test that only cares about the timing axis.
const viewLine = (index: number, text: string, startTimeMs?: number): LineView => ({
	index,
	text,
	notes: [],
	referentIds: [],
	annotated: false,
	resolved: true,
	verified: false,
	startTimeMs,
});

test("applyTiming matches Spotify's axis onto Genius' lines", () => {
	const timed = applyTiming(
		[line("Now, this looks like a job for me"), line("So, everybody, just follow me")],
		[
			{ text: "Now, this looks like a job for me", startTimeMs: 4880 },
			{ text: "So, everybody, just follow me", startTimeMs: 6500 },
		],
	);
	assert.equal(timed[0].startTimeMs, 4880);
	assert.equal(timed[1].startTimeMs, 6500);
});

test("hasTimeline reports whether following playback is possible", () => {
	assert.equal(hasTimeline([viewLine(0, "a")]), false);
	assert.equal(hasTimeline([viewLine(0, "a"), viewLine(1, "b", 10)]), true);
});

test("applyTiming gives repeated choruses their own offsets", () => {
	// Spotify repeats the chorus with a different offset; matching every Genius
	// occurrence to the first one would freeze the highlight on the first repeat.
	const timed = applyTiming(
		[line("chorus line"), line("other"), line("chorus line")],
		[
			{ text: "chorus line", startTimeMs: 1000 },
			{ text: "other", startTimeMs: 2000 },
			{ text: "chorus line", startTimeMs: 9000 },
		],
	);
	assert.equal(timed[0].startTimeMs, 1000);
	assert.equal(timed[1].startTimeMs, 2000);
	assert.equal(timed[2].startTimeMs, 9000, "the second chorus must use its own offset");
});

test("a line is annotated before its note arrives, or the panel could never be clicked", () => {
	// The page says a line is annotated as soon as it carries an anchor, so the
	// highlight has to go up on the first paint rather than after all fifty notes
	// have been fetched. Nothing has been answered yet here.
	const track = buildTrackView({
		title: "t",
		artist: "a",
		lines: [line("plain"), line("loading", ["1"])],
		notes: new Map(),
		settled: new Set(),
	});

	assert.equal(track.lines[0].annotated, false, "a line with no anchor is not annotated");
	assert.equal(track.lines[0].resolved, true, "nothing outstanding, nothing to wait for");
	assert.equal(track.lines[1].annotated, true, "the anchor alone is enough to offer the note");
	assert.equal(track.lines[1].resolved, false, "so the panel must not read the empty list as 'no note'");
	assert.equal(track.annotatedCount, 1);
	// The anchor shows before its note does, so this starts at nothing.
	assert.equal(track.annotationCount, 0);
});

test("an anchor whose note turns out to be empty stops being annotated", () => {
	// Not every referent Genius anchors carries a body, and one that does not must
	// not be left clickable with nothing behind it once that is known.
	const track = buildTrackView({
		title: "t",
		artist: "a",
		lines: [line("answered but empty", ["1"]), line("answered and real", ["2"])],
		notes: new Map([["2", note("2", "a real note")]]),
		settled: new Set(["1", "2"]),
	});

	assert.equal(track.lines[0].annotated, false, "answered with no body, so nothing to open");
	assert.equal(track.lines[0].resolved, true);
	assert.equal(track.lines[1].annotated, true);
	assert.equal(track.annotatedCount, 1, "the empty one must not be counted");
	assert.equal(track.annotationCount, 1, "and there is one note behind it");
});
