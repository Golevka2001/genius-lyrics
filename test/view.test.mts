import assert from "node:assert/strict";
import { test } from "node:test";
import { activeLineIndex, applyTiming, buildTrackView, hasTimeline, type LineView } from "../view.ts";
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

const ids = (view: LineView) => view.notes.map((note) => note.referentId);

// An unannotated line, for the tests that only care about the timing axis.
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

test("applyTiming tolerates punctuation differences", () => {
	const timed = applyTiming([line("'Cause it feels so empty")], [
		{ text: "Cause it feels so empty!", startTimeMs: 8000 },
	]);
	assert.equal(timed[0].startTimeMs, 8000);
});

test("applyTiming leaves lines unmatched when Spotify has no lyrics", () => {
	const timed = applyTiming([line("a"), line("b")], undefined);
	assert.equal(timed[0].startTimeMs, undefined);
	assert.equal(timed[1].startTimeMs, undefined);

	// Present but offsetless lines must not invent a timestamp.
	const noOffsets = applyTiming([line("a")], [{ text: "a" }]);
	assert.equal(noOffsets[0].startTimeMs, undefined);
});

test("buildTrackView attaches notes by anchor and counts annotated lines", () => {
	const view = buildTrackView({
		title: "Without Me",
		artist: "Eminem",
		lines: [line("[Chorus: Eminem]"), line("Now, this looks like a job for me", ["1"]), line("follow me", ["2", "3"])],
		notes: new Map([
			["1", note("1", "first note")],
			["2", note("2", "second note")],
			["3", note("3", "")],
		]),
	});

	assert.equal(view.lines.length, 3);
	assert.equal(view.annotatedCount, 2, "line 3 drops its empty note and stops counting");
	assert.equal(view.lines[0].annotated, false);
	assert.deepEqual(view.lines[1].notes.map((n) => n.referentId), ["1"]);
	assert.deepEqual(view.lines[2].notes.map((n) => n.referentId), ["2"]);
	assert.equal(view.source, "genius");
});

test("buildTrackView reports a track Genius has but with no annotations", () => {
	const view = buildTrackView({
		title: "Tuesday",
		artist: "UAU",
		lines: [line("line one"), line("line two")],
	});
	assert.equal(view.source, "genius");
	assert.equal(view.annotationCount, 0, "the header shows this on its own");
});

test("buildTrackView reports an empty track as having no source", () => {
	const view = buildTrackView({ title: "x", artist: "y" });
	assert.equal(view.source, "none");
	assert.equal(view.lines.length, 0);
});

test("buildTrackView keeps annotations in page order", () => {
	const view = buildTrackView({
		title: "t",
		artist: "a",
		lines: [line("chorus", ["9", "5", "7"])],
		notes: new Map([
			["9", note("9", "nine")],
			["5", note("5", "five")],
			["7", note("7", "seven")],
		]),
	});
	assert.deepEqual(view.lines[0].notes.map((n) => n.referentId), ["9", "5", "7"]);
});

test("buildTrackView marks a line verified when any note on it is", () => {
	// A line can carry several notes, and Genius tints the whole thing when one
	// of them is the artist's own, so the line takes the any, not the first.
	const view = buildTrackView({
		title: "Lose Yourself",
		artist: "Eminem",
		lines: [line("plain"), line("a reader's note", ["1"]), line("both", ["1", "2"])],
		notes: new Map([
			["1", note("1", "a reader's note")],
			["2", note("2", "Eminem's own words", true)],
		]),
	});

	assert.equal(view.lines[0].verified, false, "no note, nothing to tint");
	assert.equal(view.lines[1].verified, false);
	assert.equal(view.lines[2].verified, true, "one verified note tints the whole line");
});

test("activeLineIndex follows playback position", () => {
	const lines: LineView[] = [
		viewLine(0, "one", 1000),
		viewLine(1, "two", 3000),
		viewLine(2, "three", 6000),
	];
	assert.equal(activeLineIndex(lines, 0), -1, "before the first line nothing is active");
	assert.equal(activeLineIndex(lines, 1500), 0);
	assert.equal(activeLineIndex(lines, 2999), 0);
	assert.equal(activeLineIndex(lines, 3000), 1);
	assert.equal(activeLineIndex(lines, 9000), 2, "past the last line the last stays active");
});

test("activeLineIndex skips lines Spotify has no offset for", () => {
	// Genius carries section headers and ad-libs that Spotify does not time, so
	// the axis has holes. The highlight must not stall on one.
	const lines: LineView[] = [
		viewLine(0, "[Verse 1]"),
		viewLine(1, "first", 2000),
		viewLine(2, "untimed"),
		viewLine(3, "second", 5000),
	];
	assert.equal(activeLineIndex(lines, 100), -1);
	assert.equal(activeLineIndex(lines, 2500), 1);
	assert.equal(activeLineIndex(lines, 4000), 1, "an untimed line does not take over");
	assert.equal(activeLineIndex(lines, 5200), 3);
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

test("every line of a multi-line note carries the note", () => {
	// Genius anchors one referent across consecutive lines, and hovering any line
	// of the run brightens all of it — the lines share one note, so any of them
	// can open it.
	const track = buildTrackView({
		title: "t",
		artist: "a",
		lines: [
			{ text: "first line of the note", referentIds: ["1"] },
			{ text: "second line of the note", referentIds: ["1"] },
			{ text: "third line of the note", referentIds: ["1"] },
			{ text: "a different note", referentIds: ["2"] },
		],
		notes: new Map([
			["1", note("1", "one note")],
			["2", note("2", "another note")],
		]),
	});

	assert.deepEqual(ids(track.lines[0]), ["1"]);
	assert.deepEqual(ids(track.lines[1]), ["1"], "a continuation keeps the note it is part of");
	assert.deepEqual(ids(track.lines[2]), ["1"]);
	assert.deepEqual(ids(track.lines[3]), ["2"], "the next note starts its own region");

	// One note spanning three lines is one annotation, not three.
	assert.equal(track.annotatedCount, 4, "every line in either span is annotated");
	assert.equal(track.annotationCount, 2, "but there are only two notes");
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

test("a partially answered line still counts as annotated", () => {
	// Two referents on one line, one in: the line has a note, and the other is
	// still on its way.
	const track = buildTrackView({
		title: "t",
		artist: "a",
		lines: [line("two notes", ["1", "2"])],
		notes: new Map([["1", note("1", "landed")]]),
		settled: new Set(["1"]),
	});

	assert.equal(track.lines[0].annotated, true);
	assert.equal(track.lines[0].resolved, false, "the second referent is still outstanding");
});

test("a note that has landed tints verified, and the span is known from the anchors", () => {
	// The span a note covers comes from the page, so hover highlights it while the
	// note behind it is still being fetched.
	const track = buildTrackView({
		title: "t",
		artist: "a",
		lines: [
			{ text: "first line", referentIds: ["1"] },
			{ text: "second line", referentIds: ["1"] },
		],
		notes: new Map(),
		settled: new Set(),
	});

	assert.deepEqual(track.lines[0].referentIds, ["1"]);
	assert.deepEqual(track.lines[1].referentIds, ["1"]);
	assert.equal(track.lines[0].verified, false, "nothing verified until the note lands");
});

test("a note stays on the section header across a blank spacer", () => {
	// Genius writes a blank line before a section header, and the header itself can
	// sit inside an anchor, so the spacer must not take the note away.
	const track = buildTrackView({
		title: "t",
		artist: "a",
		lines: [
			{ text: "'Cause it feels so empty without me", referentIds: ["1"] },
			{ text: "", referentIds: [], blank: true },
			{ text: "[Verse 2: Eminem]", referentIds: ["1"] },
		],
		notes: new Map([["1", note("1", "note")]]),
	});

	assert.deepEqual(ids(track.lines[2]), ["1"], "the header keeps the note across the spacer");
});
