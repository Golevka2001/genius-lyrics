import assert from "node:assert/strict";
import { test } from "node:test";
import { activeLineIndex, applyTiming, buildTrackView, hasTimeline, type LineView } from "../view.ts";
import type { Annotation, LyricLine } from "../logic.ts";

const note = (id: string, text: string, verified = false): Annotation => ({
	referentId: id,
	fragment: id,
	text,
	verified,
	status: verified ? "verified" : "accepted",
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

const timedTexts = (lines: LyricLine[], timing: Array<{ text: string; startTimeMs: number }>) =>
	applyTiming(lines, timing).map((entry) => [entry.text, entry.startTimeMs] as const);

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

test("activeLineIndex keeps the first Genius line for a shared Spotify timestamp", () => {
	const lines = [viewLine(0, "first", 1000), viewLine(1, "second", 1000), viewLine(2, "next", 2000)];
	assert.equal(activeLineIndex(lines, 1500), 0);
	assert.equal(activeLineIndex(lines, 2200), 2);
});

test("applyTiming skips a Spotify-only line without shifting the rest", () => {
	assert.deepEqual(
		timedTexts(
			[line("first"), line("third")],
			[
				{ text: "first", startTimeMs: 1000 },
				{ text: "second, only in Spotify", startTimeMs: 2000 },
				{ text: "third", startTimeMs: 3000 },
			],
		),
		[
			["first", 1000],
			["third", 3000],
		],
	);
});

test("applyTiming leaves a Genius-only line untimed without shifting later lines", () => {
	assert.deepEqual(
		timedTexts(
			[line("first"), line("genius-only"), line("third")],
			[
				{ text: "first", startTimeMs: 1000 },
				{ text: "third", startTimeMs: 3000 },
			],
		),
		[
			["first", 1000],
			["genius-only", undefined],
			["third", 3000],
		],
	);
});

test("applyTiming ignores Genius section headers and blank lines", () => {
	assert.deepEqual(
		timedTexts(
			[line("[Verse 1]"), line("first"), line(""), line("second")],
			[
				{ text: "first", startTimeMs: 1000 },
				{ text: "second", startTimeMs: 2000 },
			],
		),
		[
			["[Verse 1]", undefined],
			["first", 1000],
			["", undefined],
			["second", 2000],
		],
	);
});

test("applyTiming skips unmatched ordinary text around a combined lyric line", () => {
	const timed = applyTiming(
		[line("[Verse 2]"), line("Palms rise to the universe"), line("As we moonshine and Molly")],
		[{ text: "Palms rise to the universe as we moonshine and molly", startTimeMs: 94950 }],
	);

	assert.equal(timed[0].startTimeMs, undefined);
	assert.equal(timed[1].startTimeMs, 94950);
	assert.equal(timed[2].startTimeMs, 94950);
});

test("applyTiming treats section headers as ordinary text", () => {
	const timed = applyTiming(
		[line("[Verse 2]"), line("Palms rise to the universe")],
		[
			{ text: "[Verse 2]", startTimeMs: 90000 },
			{ text: "Palms rise to the universe", startTimeMs: 94950 },
		],
	);

	assert.equal(timed[0].startTimeMs, 90000);
	assert.equal(timed[1].startTimeMs, 94950);
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

test("applyTiming matches a Genius line made from several Spotify lines", () => {
	const timed = applyTiming(
		[line("first verse, second verse"), line("third verse")],
		[
			{ text: "first verse", startTimeMs: 1000 },
			{ text: "second verse", startTimeMs: 2000 },
			{ text: "third verse", startTimeMs: 3000 },
		],
	);

	assert.equal(timed[0].startTimeMs, 1000);
	assert.equal(timed[1].startTimeMs, 3000);
});

test("applyTiming splits one Spotify line across several Genius lines", () => {
	const timed = applyTiming(
		[line("first part"), line("second part"), line("next line")],
		[
			{ text: "first part second part", startTimeMs: 1000 },
			{ text: "next line", startTimeMs: 5000 },
		],
	);

	assert.equal(timed[0].startTimeMs, 1000);
	assert.equal(timed[1].startTimeMs, 1000);
	assert.equal(timed[2].startTimeMs, 5000);
});

test("applyTiming handles several adjacent lines on both sides", () => {
	assert.deepEqual(
		timedTexts(
			[line("one"), line("two"), line("three"), line("four"), line("five")],
			[
				{ text: "one two", startTimeMs: 1000 },
				{ text: "three four", startTimeMs: 2000 },
				{ text: "five", startTimeMs: 3000 },
			],
		),
		[
			["one", 1000],
			["two", 1000],
			["three", 2000],
			["four", 2000],
			["five", 3000],
		],
	);
});

test("applyTiming does not let a near match consume an unrelated following line", () => {
	assert.deepEqual(
		timedTexts(
			[line("I know the storm is coming"), line("unrelated lyric"), line("final line")],
			[
				{ text: "I know the storm is comin", startTimeMs: 1000 },
				{ text: "final line", startTimeMs: 3000 },
			],
		),
		[
			["I know the storm is coming", 1000],
			["unrelated lyric", undefined],
			["final line", 3000],
		],
	);
});

test("applyTiming handles three-to-one and one-to-three groups", () => {
	assert.deepEqual(
		timedTexts(
			[line("first"), line("second"), line("third"), line("fourth phrase continues")],
			[
				{ text: "first second third", startTimeMs: 1000 },
				{ text: "fourth", startTimeMs: 2000 },
				{ text: "phrase", startTimeMs: 3000 },
				{ text: "continues", startTimeMs: 4000 },
			],
		),
		[
			["first", 1000],
			["second", 1000],
			["third", 1000],
			["fourth phrase continues", 2000],
		],
	);
});

test("applyTiming matches Diamonds when Spotify combines two Genius lines", () => {
	const timed = applyTiming(
		[
			line("You're a shooting star I see"),
			line("A vision of ecstasy"),
			line("When you hold me, I'm alive"),
			line("We're like diamonds in the sky"),
		],
		[
			{ text: "You're a shooting star I see, a vision of ecstasy", startTimeMs: 21830 },
			{ text: "When you hold me, I'm alive, we're like diamonds in the sky", startTimeMs: 26400 },
		],
	);

	assert.equal(timed[0].startTimeMs, 21830);
	assert.equal(timed[1].startTimeMs, 21830);
	assert.equal(timed[2].startTimeMs, 26400);
	assert.equal(timed[3].startTimeMs, 26400);
});

test("applyTiming keeps Diamonds Verse 2 groups in order", () => {
	const timed = applyTiming(
		[
			line("Palms rise to the universe"),
			line("As we moonshine and Molly"),
			line("Feel the warmth, we'll never die"),
			line("We're like diamonds in the sky"),
		],
		[
			{ text: "Palms rise to the universe as we moonshine and molly", startTimeMs: 94950 },
			{ text: "Feel the warmth, we'll never die, we're like diamonds in the sky", startTimeMs: 99620 },
		],
	);

	assert.equal(timed[0].startTimeMs, 94950);
	assert.equal(timed[1].startTimeMs, 94950);
	assert.equal(timed[2].startTimeMs, 99620);
	assert.equal(timed[3].startTimeMs, 99620);
});

test("applyTiming survives unmatched material on both sides", () => {
	assert.deepEqual(
		timedTexts(
			[line("la la la"), line("shared one"), line("spoken bridge"), line("shared two")],
			[
				{ text: "instrumental break", startTimeMs: 500 },
				{ text: "shared one", startTimeMs: 1000 },
				{ text: "crowd noise", startTimeMs: 1500 },
				{ text: "shared two", startTimeMs: 2000 },
				{ text: "instrumental outro", startTimeMs: 2500 },
			],
		),
		[
			["la la la", undefined],
			["shared one", 1000],
			["spoken bridge", undefined],
			["shared two", 2000],
		],
	);
});

test("applyTiming keeps punctuation and case differences from breaking alignment", () => {
	assert.deepEqual(timedTexts([line("I'M OUTTA CONTROL!")], [{ text: "I'm outta control", startTimeMs: 1200 }]), [
		["I'M OUTTA CONTROL!", 1200],
	]);
});

test("applyTiming keeps non-Latin lyrics alignable", () => {
	assert.deepEqual(
		timedTexts(
			[line("你好吗？"), line("我很好")],
			[
				{ text: "你好吗", startTimeMs: 1000 },
				{ text: "我很好", startTimeMs: 2000 },
			],
		),
		[
			["你好吗？", 1000],
			["我很好", 2000],
		],
	);
});

test("applyTiming ignores ad-lib differences in parenthetical text", () => {
	const timed = applyTiming(
		[line("(Yes) One touch and I brand-newed it for ya (Ooh)"), line("Next line")],
		[
			{ text: "(Yes) one touch and I brand-newed it for ya (oh)", startTimeMs: 1000 },
			{ text: "Next line", startTimeMs: 2000 },
		],
	);

	assert.equal(timed[0].startTimeMs, 1000);
	assert.equal(timed[1].startTimeMs, 2000);
});

test("applyTiming tolerates small lyric transcription differences", () => {
	const timed = applyTiming(
		[line("My twisted humor make him laugh so often"), line("Next line")],
		[
			{ text: "My twisted humor makes him laugh so often", startTimeMs: 1000 },
			{ text: "Next line", startTimeMs: 2000 },
		],
	);

	assert.equal(timed[0].startTimeMs, 1000);
	assert.equal(timed[1].startTimeMs, 2000);
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
