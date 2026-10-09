import assert from "node:assert/strict";
import { test } from "node:test";
import { activeLineIndex, applyTiming, buildTrackView, hasTimeline, type LineView } from "../view.ts";
import type { Annotation, LyricLine } from "../logic.ts";

const note = (id: string, text: string, classification = "accepted"): Annotation => ({
	referentId: id,
	fragment: id,
	text,
	classification,
	source: "referent",
	authors: [],
	blocks: [],
});

const line = (text: string, referentIds: string[] = []): LyricLine => ({ text, referentIds });

const ids = (view: LineView) => view.notes.map((note) => note.referentId);

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
			["2", note("2", "second note", "unreviewed")],
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
	assert.equal(view.annotatedCount, 0);
	assert.equal(view.annotationless, true);
});

test("buildTrackView reports an empty track as having no source", () => {
	const view = buildTrackView({ title: "x", artist: "y" });
	assert.equal(view.source, "none");
	assert.equal(view.lines.length, 0);
	// Nothing on Genius at all is not the same as "no annotations".
	assert.equal(view.annotationless, undefined);
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

test("activeLineIndex follows playback position", () => {
	const lines: LineView[] = [
		{ index: 0, text: "one", notes: [], annotated: false, startTimeMs: 1000 },
		{ index: 1, text: "two", notes: [], annotated: false, startTimeMs: 3000 },
		{ index: 2, text: "three", notes: [], annotated: false, startTimeMs: 6000 },
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
		{ index: 0, text: "[Verse 1]", notes: [], annotated: false },
		{ index: 1, text: "first", notes: [], annotated: false, startTimeMs: 2000 },
		{ index: 2, text: "untimed", notes: [], annotated: false },
		{ index: 3, text: "second", notes: [], annotated: false, startTimeMs: 5000 },
	];
	assert.equal(activeLineIndex(lines, 100), -1);
	assert.equal(activeLineIndex(lines, 2500), 1);
	assert.equal(activeLineIndex(lines, 4000), 1, "an untimed line does not take over");
	assert.equal(activeLineIndex(lines, 5200), 3);
});

test("hasTimeline reports whether following playback is possible", () => {
	assert.equal(hasTimeline([{ index: 0, text: "a", notes: [], annotated: false }]), false);
	assert.equal(
		hasTimeline([
			{ index: 0, text: "a", notes: [], annotated: false },
			{ index: 1, text: "b", notes: [], annotated: false, startTimeMs: 10 },
		]),
		true,
	);
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
