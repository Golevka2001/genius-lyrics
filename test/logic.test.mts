import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	isOriginalSong,
	parseLyricLines,
	parseNoteBlocks,
	parseReferent,
	parseSong,
	parseSpotifyLyrics,
	pickHit,
} from "../logic.ts";

const lyricsPage = () => readFileSync(new URL("./fixtures/lyrics-page.html", import.meta.url), "utf8");

test("parseSpotifyLyrics accepts Spotify's string timestamps", () => {
	const parsed = parseSpotifyLyrics({
		lyrics: {
			syncType: "LINE_SYNCED",
			lines: [
				{ words: "Sorry", startTimeMs: "1234" },
				{ words: "Next line", startTimeMs: 5678 },
			],
		},
	});

	assert.equal(parsed?.synced, true);
	assert.deepEqual(parsed?.lines, [
		{ text: "Sorry", startTimeMs: 1234 },
		{ text: "Next line", startTimeMs: 5678 },
	]);
});

test("parseReferent reads verified off the fallback endpoint as well", () => {
	// annotations/{id} is what answers when a referent is still indexing. It has
	// no annotation list, and the annotation it returns reports itself merely
	// accepted even when verified — so the referent's own classification is the
	// only witness left and reading both is what keeps the tint either way.
	const annotation = parseReferent(
		{
			response: {
				referent: { id: 42545, classification: "verified" },
				annotation: {
					id: 42545,
					verified: false,
					state: "accepted",
					body: { dom: { tag: "root", children: ["Own words."] } },
				},
			},
		},
		"42545",
	);
	assert.equal(annotation.verified, true);
	assert.equal(annotation.source, "annotation");
});

test("parseLyricLines reads lines and their anchors from the real page", () => {
	const lines = parseLyricLines(lyricsPage());
	assert.ok(lines.length > 20, `expected the full lyric block, got ${lines.length} lines`);

	// The fixture leads with a UI panel that also carries the attribute; it must
	// be skipped in favour of the block that actually holds anchors.
	const anchored = lines.filter((line) => line.referentIds.length > 0);
	assert.ok(anchored.length > 10, `expected anchored lines, got ${anchored.length}`);
});

test("pickHit prefers the exact artist over one that only contains it", () => {
	// "Radiohead (Cover Band)" contains "Radiohead", so scoring the two alike left
	// the tie to Genius' order, which put the cover in place of the song played.
	const hits = [
		{ id: 1, title: "Creep", url: "u1", artist: "Radiohead (Cover Band)", annotationCount: 9 },
		{ id: 2, title: "Creep", url: "u2", artist: "Radiohead", annotationCount: 0 },
	];
	assert.equal(pickHit(hits, "Creep", "Radiohead")?.id, 2);
});

test("pickHit scores each artist separately", () => {
	// Spotify joins with ", " and Genius with " & ", and normalize folds both to
	// one string. Comparing the joined forms made a two-artist credit an exact
	// match, which handed the track to whichever version credits the fewest
	// artists — the Film Version, which carries no annotations at all.
	const hits = [
		{
			id: 1,
			title: "Despacito (Remix)",
			url: "u1",
			artist: "Luis Fonsi & Daddy Yankee (Ft. Justin Bieber)",
			annotationCount: 11,
		},
		{
			id: 2,
			title: "Despacito (Film Version)",
			url: "u2",
			artist: "Luis Fonsi & Daddy Yankee",
			annotationCount: 0,
		},
	];
	assert.equal(pickHit(hits, "Despacito", "Luis Fonsi, Daddy Yankee")?.id, 1);
});

test("pickHit tells a remix from the track it remixes", () => {
	// Genius ranks "Despacito (Remix)" above "Despacito" and annotates it more
	// heavily, so stripping the parenthetical left the two tied and the remix won
	// a Spotify track that never mentions Justin Bieber.
	const hits = [
		{
			id: 3057010,
			title: "Despacito (Remix)",
			url: "u1",
			artist: "Luis Fonsi & Daddy Yankee (Ft. Justin Bieber)",
			annotationCount: 11,
		},
		{ id: 2955220, title: "Despacito", url: "u2", artist: "Luis Fonsi & Daddy Yankee", annotationCount: 10 },
	];
	// The 2017 single, with no Bieber among its artists.
	assert.equal(pickHit(hits, "Despacito", "Luis Fonsi, Daddy Yankee")?.id, 2955220);
	// The same title once Spotify does list him, and when it says "Remix" itself.
	assert.equal(pickHit(hits, "Despacito", "Luis Fonsi, Daddy Yankee, Justin Bieber")?.id, 3057010);
	assert.equal(pickHit(hits, "Despacito (Remix)", "Luis Fonsi, Daddy Yankee, Justin Bieber")?.id, 3057010);
});

test("parseLyricLines keeps the italics and bold that mark who sings what", () => {
	// Shape taken from XG's IN THE RAIN.
	const html = `<div data-lyrics-container="true">[Verse 1: Juria, <i>Chisa</i>]<br/>
		Rain on my shoulder<br/>
		<i>'Cause we had each other<br/>Fought through the weather</i><br/>
		<b>I'm washing it all away</b><br/>
		<i><b>Goodbye</b></i></div>`;

	const lines = parseLyricLines(html);
	const header = lines.find((line) => line.text.startsWith("[Verse 1:"));
	const styled = lines.find((line) => line.text === "I'm washing it all away");
	assert.ok(header);
	assert.ok(styled);
	assert.deepEqual(header.runs, [{ text: "[Verse 1: Juria, " }, { text: "Chisa", italic: true }, { text: "]" }]);
	assert.deepEqual(styled.runs, [{ text: "I'm washing it all away", bold: true }]);
});

test("parseLyricLines drops the contributor/translation header", () => {
	// Genius puts the header inside the same container as the lyrics, marking it
	// with data-exclude-from-selection. It used to become the first "line", which
	// put a wall of language names above the lyrics.
	const lines = parseLyricLines(lyricsPage());
	const first = lines[0].text;
	assert.ok(!first.includes("Contributors"), `header leaked into the lyrics: ${first.slice(0, 60)}`);
	assert.ok(!first.includes("Translations"), `translation list leaked: ${first.slice(0, 60)}`);
	assert.ok(!first.includes("Read More"), `blurb leaked: ${first.slice(0, 60)}`);
});

test("a note opens once but stays attached across the lines it spans", () => {
	// Genius anchors one referent across consecutive lines when the phrase runs
	// over them. Attaching the id to only the first left the rest looking
	// unannotated; attaching it to every repeat made each look like a new note.
	const lines = parseLyricLines(lyricsPage());

	let starts = 0;
	for (const [index, line] of lines.entries()) {
		if (!line.referentIds.length) continue;
		if (line.noteStart) {
			starts += 1;
			// The line that opens a note carries the id itself, never an id
			// inherited from an anchor that started higher up.
			assert.ok(!/\n/.test(line.text), `opener at ${index} spans more than one line of text`);
		} else {
			// A continuation always follows a line of the same span, looking past the
			// blank spacer Genius puts before a section header — a spacer is layout,
			// and the section header that follows it can be inside an anchor too.
			let above = index - 1;
			while (above >= 0 && lines[above].blank) above -= 1;
			const previous = lines[above];
			assert.ok(
				previous.referentIds.some((id) => line.referentIds.includes(id)),
				`continuation at ${index} has no opener above it`,
			);
		}
	}

	assert.ok(starts > 0, "expected the fixture to carry annotations");
	// A note really does span more than one line, otherwise this is untested.
	const continuations = lines.filter((line) => line.referentIds.length && !line.noteStart);
	assert.ok(continuations.length > 0, "expected at least one note to cover several lines");
});

test("an anchor that closes on its own line does not carry onto the next", () => {
	// Counting opens against closes cannot tell this anchor from one wrapping a
	// break: both balance, and treating that as "still open" ran the note over every
	// line after it. Shape taken from XG's WINTER WITHOUT YOU.
	const html = `<div data-lyrics-container="true">
		<a href="/111/x/on-the-dl"><span>On the DL I still miss you though</span></a><br/>
		Looking cute at every party<br/>
		Posting on my story<br/>
		<a href="/222/x/joyful"><i>Joyful, joyful<br/>Everybody come and raise your voice</i></a>
	</div>`;
	const lines = parseLyricLines(html).filter((line) => !line.blank);

	assert.deepEqual(lines[0].referentIds, ["111"], "the anchor's own line");
	assert.deepEqual(lines[1].referentIds, [], "a closed anchor must not reach the next line");
	assert.deepEqual(lines[2].referentIds, []);
	// One that really does wrap a break still covers both of its lines.
	assert.deepEqual(lines[3].referentIds, ["222"]);
	assert.deepEqual(lines[4].referentIds, ["222"]);
});

test("a repeated chorus opens its note again at each repeat", () => {
	const lines = parseLyricLines(`
		<div data-lyrics-container="true">first verse<br/><a href="/111/x/chorus">chorus line</a></div>
		<div data-lyrics-container="true">second verse<br/><a href="/111/x/chorus">chorus line</a></div>
	`);

	assert.deepEqual(
		lines.filter((line) => line.noteStart).map((line) => line.text),
		["chorus line", "chorus line"],
	);
});

test("parseLyricLines keeps every blank line Genius writes", () => {
	// A section header is written in the same markup as a lyric, so the blank is
	// the only signal and it is kept without testing what follows. This includes
	// the one ending each container, which belongs to the next one's header —
	// dropping it left every chorus but the first jammed against the line above.
	const lines = parseLyricLines(lyricsPage());
	const blanks = lines.filter((line) => line.blank);
	assert.ok(blanks.length >= 4, `expected the song's section breaks, got ${blanks.length}`);

	// No run of consecutive blanks, and none trailing: a doubled <br> is one gap.
	for (const [index, line] of lines.entries()) {
		if (!line.blank) continue;
		assert.equal(lines[index + 1]?.blank, undefined, `two blanks in a row at ${index}`);
	}
	assert.equal(lines[lines.length - 1].blank, undefined, "the song must not end on a blank");
});

test("isOriginalSong tells an original from a translation", () => {
	// Genius lists a translation among its own siblings and leaves the original
	// out, which is how a Swedish page of Despacito is told apart from the
	// Spanish one without reading either title.
	const original = parseSong({
		response: { song: { id: 3057010, translation_songs: [{ id: 3083456 }, { id: 3067667 }] } },
	});
	const swedish = parseSong({
		response: { song: { id: 3083456, translation_songs: [{ id: 3057010 }, { id: 3083456 }] } },
	});

	assert.ok(original);
	assert.ok(swedish);
	assert.equal(isOriginalSong(original), true);
	assert.equal(isOriginalSong(swedish), false);
});

test("parseNoteBlocks keeps paragraphs, quotes and images apart", () => {
	// Genius writes annotations as prose with quoted lyrics, artwork and video
	// links inline; flattening them into one string lost all of that.
	const blocks = parseNoteBlocks({
		tag: "root",
		children: [
			{ tag: "p", children: ["This refrain interpolates Malcolm McLaren’s track."] },
			{
				tag: "blockquote",
				children: [
					{
						tag: "p",
						children: ["Two buffalo gals go around the outside", { tag: "br" }, "Round the outside"],
					},
				],
			},
			{ tag: "p", children: ["And it is sampled more than 100 times."] },
			{ tag: "img", attributes: { src: "https://images.rapgenius.com/a.jpg", alt: "" } },
			{ tag: "a", attributes: { href: "https://youtu.be/HCBN7lyLT4w?t=12" }, children: ["the video"] },
		],
	});

	assert.deepEqual(
		blocks.map((block) => block.kind),
		["paragraph", "quote", "paragraph", "image", "paragraph"],
	);
	assert.equal((blocks[3] as { src: string }).src, "https://images.rapgenius.com/a.jpg");
});

test("parseNoteBlocks keeps inline links inside their sentence", () => {
	// Genius underlines artists, labels and outbound references inside its prose.
	// Flattening them dropped both the underlines and the destinations, and
	// hoisting an outbound link out of its sentence read as a separate item.
	const blocks = parseNoteBlocks({
		tag: "root",
		children: [
			{
				tag: "p",
				children: [
					"released under ",
					{
						tag: "a",
						attributes: { href: "https://genius.com/artists/Obie-trice" },
						children: ["Obie Trice"],
					},
					"’s label ",
					{
						tag: "a",
						attributes: { href: "https://genius.com/artists/Shady-records" },
						children: ["Shady Records"],
					},
					".",
				],
			},
		],
	});

	assert.equal(blocks.length, 1);
	const paragraph = blocks[0] as { kind: "paragraph"; spans: Array<{ text: string; href?: string }> };
	assert.deepEqual(
		paragraph.spans.filter((span) => span.href),
		[
			{ text: "Obie Trice", href: "https://genius.com/artists/Obie-trice" },
			{ text: "Shady Records", href: "https://genius.com/artists/Shady-records" },
		],
	);
});

test("parseLyricLines joins a song split across several containers", () => {
	// Genius splits a long song into consecutive containers rather than one long
	// one. Reading only the first truncated "Without Me" at 38 of 121 lines, right
	// after its first verse, so every annotated block has to be read.
	const lines = parseLyricLines(lyricsPage());
	assert.ok(lines.length > 100, `expected the whole song, got ${lines.length} lines`);
	assert.equal(lines[0].text.startsWith("[Intro:"), true, "starts at the first section");
	assert.equal(lines.at(-1)?.blank, undefined, "does not add a trailing blank line");
});
