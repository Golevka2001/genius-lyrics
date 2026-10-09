import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	attachAnnotations,
	parseNoteBlocks,
	domToText,
	extractLyricLines,
	extractReferentIds,
	findFragmentStart,
	fragmentMatchesLine,
	parseLyricLines,
	parseReferent,
	parseSearchResults,
	parseSong,
	parseSpotifyLyrics,
	type Annotation,
} from "../logic.ts";

const lyricsPage = () => readFileSync(new URL("./fixtures/lyrics-page.html", import.meta.url), "utf8");

test("domToText flattens Genius' prose DOM", () => {
	// Built inline rather than read from a fixture: what matters here is how a prose
	// DOM becomes text, not that some captured response happens to contain one.
	const text = domToText({
		tag: "root",
		children: [
			{ tag: "p", children: ["First paragraph."] },
			{
				tag: "p",
				children: ["Second with ", { tag: "a", attributes: { href: "/artists/1" }, children: ["a link"] }, " and ", { tag: "em", children: ["emphasis"] }, "."],
			},
			{ tag: "p", children: ["Third."] },
		],
	});
	assert.equal(text, "First paragraph.\nSecond with a link and emphasis.\nThird.");
});

test("parseSong reads metadata but keeps prose out of the lyrics field", () => {
	// description.dom is Genius' editorial prose. Reading it as lyrics is the bug
	// this guards, so the assertion is about which field the prose lands in.
	const song = parseSong({
		response: {
			song: {
				id: 1,
				title: "Creep",
				full_title: "Creep by Radiohead",
				url: "https://genius.com/Radiohead-creep-lyrics",
				annotation_count: 33,
				description: { dom: { tag: "root", children: [{ tag: "p", children: ["An editorial note."] }] } },
			},
		},
	});
	assert.ok(song);
	assert.equal(song.id, 1);
	assert.equal(song.title, "Creep");
	assert.equal(song.annotationCount, 33);
	assert.equal(song.description, "An editorial note.");
});

test("parseSearchResults returns typed candidates", () => {
	const hits = parseSearchResults({
		response: {
			sections: [
				{
					hits: [
						{
							result: {
								id: 109096,
								title: "Creep",
								full_title: "Creep by Radiohead",
								url: "https://genius.com/Radiohead-creep-lyrics",
								artist_names: "Radiohead",
								annotation_count: 33,
							},
						},
					],
				},
			],
		},
	});
	assert.equal(hits.length, 1);
	assert.equal(hits[0].id, 109096);
	assert.equal(hits[0].artist, "Radiohead");
	assert.equal(hits[0].annotationCount, 33);
	assert.equal(hits[0].translation, false);
});

test("parseReferent prefers the referent's own annotation", () => {
	// The referent carries a list; a bare annotation payload is the fallback when
	// that list is absent. Which one supplied the body is recorded in `source`.
	const fromReferent = parseReferent(
		{ response: { referent: { id: 1, fragment: "x", annotations: [{ body: { dom: { tag: "root", children: [{ tag: "p", children: ["From the list."] }] } } }] } } },
		"1",
	);
	assert.equal(fromReferent.text, "From the list.");
	assert.equal(fromReferent.source, "referent");

	const fromAnnotation = parseReferent(
		{ response: { annotation: { id: 1, body: { dom: { tag: "root", children: [{ tag: "p", children: ["From the payload."] }] } } } } },
		"1",
	);
	assert.equal(fromAnnotation.text, "From the payload.");
	assert.equal(fromAnnotation.source, "annotation");
});

test("parseReferent survives a missing payload", () => {
	const annotation = parseReferent(null, "1");
	assert.equal(annotation.text, "");
	assert.equal(annotation.source, "none");
});

test("parseLyricLines reads lines and their anchors from the real page", () => {
	const lines = parseLyricLines(lyricsPage());
	assert.ok(lines.length > 20, `expected the full lyric block, got ${lines.length} lines`);

	// The fixture leads with a UI panel that also carries the attribute; it must
	// be skipped in favour of the block that actually holds anchors.
	const anchored = lines.filter((line) => line.referentIds.length > 0);
	assert.ok(anchored.length > 10, `expected anchored lines, got ${anchored.length}`);
});

test("parseLyricLines skips the UI panel and the plain-text duplicate", () => {
	const lines = parseLyricLines(lyricsPage());
	// The chrome block is one long run-on line of counts and language names.
	assert.ok(!lines.some((line) => /Contributors.*Translations/.test(line.text)), "UI chrome leaked into lyrics");
	// The duplicate copy carries no anchors, so it must not be the one returned.
	assert.ok(lines.some((line) => line.referentIds.length > 0), "expected the annotated copy");
});

test("extractLyricLines decodes entities and reads plain lyrics", () => {
	const html = `<div data-lyrics-container="true">
		One two three four<br>
		&#x27;Cause it feels so empty &amp; cold<br>
		Five six seven eight<br>
		Nine ten eleven twelve
	</div>`;
	const blocks = extractLyricLines(html);
	assert.deepEqual(blocks[0], [
		"One two three four",
		"'Cause it feels so empty & cold",
		"Five six seven eight",
		"Nine ten eleven twelve",
	]);
});

test("parseLyricLines requires anchors, so an unannotated page yields nothing", () => {
	// Annotations are the whole point of this parser: with no anchors there is
	// nothing to attach, and extractLyricLines is the plain-text counterpart.
	const html = `<div data-lyrics-container="true">Just plain lyrics<br>with no anchors<br>x<br>y</div>`;
	assert.deepEqual(parseLyricLines(html), []);
});

test("extractLyricLines finds every qualifying block", () => {
	const blocks = extractLyricLines(lyricsPage());
	assert.ok(blocks.length >= 1);
	assert.ok(blocks[0].length > 20);
});

test("extractReferentIds finds numeric path segments", () => {
	const html = `
		<a href="/166763/Eminem-without-me/Obie-trice">x</a>
		<a href="https://genius.com/artists/Thom-yorke">z</a>
		<a href="/42867/Creatures/The-Beatles">dup</a>
		<a href="/42867/Creatures/The-Beatles-again">dup</a>
	`;
	assert.deepEqual(extractReferentIds(html), ["166763", "42867"]);
});

test("parseLyricLines is linear in page size, not quadratic", () => {
	// A single greedy pattern over a full Genius page caused multi-second
	// backtracking; the scan-based parser must stay fast.
	const filler = "<div>".repeat(20000);
	const html = `${filler}<div data-lyrics-container="true">${"line<br>".repeat(40)}</div>`;
	const started = process.hrtime.bigint();
	parseLyricLines(html);
	const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
	assert.ok(elapsedMs < 500, `parser took ${elapsedMs.toFixed(0)}ms`);
});

test("fragmentMatchesLine tolerates Genius' de-accented fragments", () => {
	assert.ok(fragmentMatchesLine("Conect dnt run dry we got it all day", "Conect, dn't run dry"));
	assert.ok(fragmentMatchesLine("Creep", "creep"));
	assert.ok(!fragmentMatchesLine("totally different words", "Creep"));
	assert.ok(!fragmentMatchesLine("", "Creep"));
});

test("findFragmentStart spans a line break", () => {
	const lines = ["Obie Trice, real name", "Ra— slick like a freshly sharpened knife"];
	assert.equal(findFragmentStart(lines, "Obie Trice, real name\n Ra—"), 0);
	assert.equal(findFragmentStart(lines, "totally absent text here"), -1);
});

test("attachAnnotations places notes by anchor, not by text", () => {
	const notes = new Map<string, Annotation>([
		["1", { referentId: "1", fragment: "anything", text: "note one", classification: "accepted", source: "referent", authors: [], blocks: [] }],
		["2", { referentId: "2", fragment: "unrelated", text: "note two", classification: "unreviewed", source: "referent", authors: [], blocks: [] }],
	]);
	// Line 1 carries anchor "1" even though line 0's text matches note 2's
	// fragment better; the anchor must win.
	const lines = [
		{ text: "So, everybody, just follow me", referentIds: [] },
		{ text: "Now, this looks like a job for me", referentIds: ["1"] },
	];
	const placed = attachAnnotations(lines, notes);
	assert.equal(placed.length, 1);
	assert.equal(placed[0].index, 1);
	assert.deepEqual(placed[0].notes.map((n) => n.referentId), ["1"]);
});

test("attachAnnotations drops notes with no body", () => {
	const lines = [{ text: "a line", referentIds: ["1"] }];
	const notes = new Map<string, Annotation>([
		["1", { referentId: "1", fragment: "a line", text: "", classification: "unreviewed", source: "none", authors: [], blocks: [] }],
	]);
	assert.equal(attachAnnotations(lines, notes).length, 0);
});

test("parseSpotifyLyrics reads synced lines and the timing axis", () => {
	const parsed = parseSpotifyLyrics({
		lyrics: {
			syncType: "LINE_SYNCED",
			lines: [
				{ words: "Is this it", startTimeMs: 12345 },
				{ words: "Send me an angel", startTimeMs: 22000 },
			],
		},
	});
	assert.ok(parsed);
	assert.equal(parsed.synced, true);
	assert.equal(parsed.lines[0].startTimeMs, 12345);
});

test("parseSpotifyLyrics handles unsynced lyrics and absent payloads", () => {
	const unsynced = parseSpotifyLyrics({ lyrics: { syncType: "UNSYNCED", lines: [{ words: "a" }] } });
	assert.equal(unsynced?.synced, false);
	assert.equal(unsynced?.lines[0].startTimeMs, undefined);
	assert.equal(parseSpotifyLyrics({}), null);
	assert.equal(parseSpotifyLyrics(null), null);
});

test("parseSearchResults treats a rate-limited body as no hits, not a crash", () => {
	// Genius answers 429 with no sections; this must degrade quietly so callers
	// can tell "not on Genius" apart from "try again".
	assert.deepEqual(parseSearchResults({ code: 429 }), []);
	assert.deepEqual(parseSearchResults({}), []);
	assert.deepEqual(parseSearchResults(null), []);
});

test("parseReferent ignores a rate-limited body", () => {
	const annotation = parseReferent({ code: 429 }, "1");
	assert.equal(annotation.text, "");
	assert.equal(annotation.source, "none");
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

test("parseLyricLines keeps the section label that follows the header", () => {
	const lines = parseLyricLines(lyricsPage());
	assert.match(lines[0].text, /^\[Intro:/);
});

test("a note opens once but stays attached across the lines it spans", () => {
	// Genius anchors one referent across consecutive lines when the phrase runs
	// over them, so several lines share an id. Attaching the id to only the first
	// left the rest looking unannotated; attaching it to every repeat of a chorus
	// made each repeat look like a separate note. The span carries the id and only
	// the first line is marked as the one that opens it.
	const lines = parseLyricLines(lyricsPage());

	let starts = 0;
	for (const [index, line] of lines.entries()) {
		if (!line.referentIds.length) continue;
		if (line.noteStart) {
			starts += 1;
			// The line that opens a note carries the id itself, never an id
			// inherited from an anchor that started higher up.
			assert.ok(
				!/\n/.test(line.text),
				`opener at ${index} spans more than one line of text`,
			);
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

test("a repeated chorus opens its note again at each repeat", () => {
	// Genius renders the chorus in every one of its containers and anchors the
	// same referent id each time. Each repeat is a separate region the listener
	// reaches again, so each one opens the note — the region is highlighted, not
	// globally marked as already read.
	const lines = parseLyricLines(lyricsPage());
	const chorusStarts = lines.filter(
		(line) => line.noteStart && /this looks like a job for me/i.test(line.text),
	);
	assert.ok(chorusStarts.length >= 3, `expected the chorus to open each time, got ${chorusStarts.length}`);
});

test("parseLyricLines keeps every blank line Genius writes", () => {
	// Genius separates sections with <br><br>. The blank is the only signal: a
	// section header is written in exactly the same markup as a lyric, so nothing
	// in the page distinguishes them structurally and a rule that looked at the
	// text would break on any wording Genius changes.
	//
	// Blanks are kept unconditionally, including the one that ends each container
	// — that one belongs to the header the next container opens with, and dropping
	// it is what left every chorus but the first jammed against the line above.
	const lines = parseLyricLines(lyricsPage());
	const blanks = lines.filter((line) => line.blank);
	assert.ok(blanks.length >= 4, `expected the song's section breaks, got ${blanks.length}`);

	// No run of consecutive blanks, and none trailing: a doubled <br> is one gap.
	for (const [index, line] of lines.entries()) {
		if (!line.blank) continue;
		assert.equal(lines[index + 1]?.blank, undefined, `two blanks in a row at ${index}`);
		assert.notEqual(line.text, undefined);
	}
	assert.equal(lines[lines.length - 1].blank, undefined, "the song must not end on a blank");
});

test("parseLyricLines is linear in page size, not quadratic", () => {
	// A single greedy pattern over a full Genius page caused multi-second
	// backtracking; the scan-based parser must stay fast.
	const filler = "<div>".repeat(20000);
	const html = `${filler}<div data-lyrics-container="true">${"line<br>".repeat(40)}</div>`;
	const started = process.hrtime.bigint();
	parseLyricLines(html);
	const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
	assert.ok(elapsedMs < 500, `parser took ${elapsedMs.toFixed(0)}ms`);
});

test("parseReferent credits every co-signer, not the moderator account", () => {
	// A referent carries `annotator_login` for the Genius account that opened it,
	// which is a moderator handle. The writers are in `authors`, and one
	// annotation is routinely signed by several people.
	const annotation = parseReferent(
		{
			response: {
				referent: {
					id: 26241,
					classification: "accepted",
					annotator_login: "nws",
					fragment: "line one\n line two",
					annotations: [
						{
							id: 26241,
							body: { dom: { tag: "root", children: [{ tag: "p", children: ["Written by several people."] }] } },
							authors: [
								{ user: { name: "First Writer" } },
								{ user: { name: "Second Writer" } },
								{ user: {} },
							],
							votes_total: 312,
						},
					],
				},
			},
		},
		"26241",
	);

	assert.deepEqual(annotation.authors, ["First Writer", "Second Writer"]);
	assert.equal(annotation.votes, 312);
	assert.ok(!annotation.authors.includes("nws"), "the moderator handle is not a writer");
});

test("parseReferent survives a referent with no annotation body", () => {
	const annotation = parseReferent(
		{ response: { referent: { id: 1, classification: "unreviewed", fragment: "x", annotations: [] } } },
		"1",
	);
	assert.equal(annotation.text, "");
	assert.deepEqual(annotation.authors, []);
	assert.equal(annotation.source, "none");
	assert.equal(annotation.votes, undefined);
});

test("parseReferent reads the body out of a dom with links", () => {
	// Genius wraps artist and label names in <a>, so a naive text read returns
	// nothing at all.
	const annotation = parseReferent(
		{
			response: {
				referent: {
					classification: "accepted",
					fragment: "Obie Trice",
					annotations: [
						{
							votes_total: 10,
							body: {
								dom: {
									tag: "root",
									children: [
										{
											tag: "p",
											children: [
												{ tag: "a", children: ["Obie Trice"], attributes: { href: "/artists/810" } },
												" was one of Eminem’s protégés under ",
												{ tag: "a", children: ["Shady Records"], attributes: { href: "/artists/143985" } },
												".",
											],
										},
									],
								},
							},
						},
					],
				},
			},
		},
		"1",
	);
	assert.match(annotation.text, /Obie Trice was one of Eminem’s protégés under Shady Records\./);
});

test("parseSearchResults prefers an annotated original over translations", () => {
	// Genius returned six Polish/Turkish translations before the English
	// original for "Rihanna Genius", so taking the first hit showed a translated
	// text whose annotations talk about a different language's wording.
	const payload = {
		response: {
			sections: [
				{
					hits: [
						{ result: { id: 1, title: "S&M", full_title: "Rihanna - S&M (polskie tłumaczenie) by Polskie tłumaczenia Genius", url: "u1", artist_names: "Polskie tłumaczenia Genius", annotation_count: 3 } },
						{ result: { id: 2, title: "Genius", full_title: "Genius by Rihanna", url: "u2", artist_names: "Rihanna", annotation_count: 12 } },
					],
				},
			],
		},
	};

	const hits = parseSearchResults(payload);
	assert.equal(hits[0].id, 2, "the annotated original must come first");
	assert.equal(hits[0].translation, false);
	assert.equal(hits[0].annotationCount, 12);
	assert.equal(hits[1].translation, true);
});

test("parseSearchResults ranks an unannotated original above a translation", () => {
	const payload = {
		response: {
			sections: [
				{
					hits: [
						{ result: { id: 10, title: "Rehab", full_title: "Rihanna - Rehab (türkçe çeviri) by Genius Türkçe Çeviriler", url: "u", artist_names: "Genius Türkçe Çeviriler", annotation_count: 5 } },
						{ result: { id: 11, title: "Rehab", full_title: "Rehab by Rihanna", url: "u", artist_names: "Rihanna", annotation_count: 0 } },
					],
				},
			],
		},
	};
	const hits = parseSearchResults(payload);
	assert.equal(hits[0].id, 11, "the original is still the right text even without notes");
});

test("parseSearchResults keeps Genius' order inside a tier", () => {
	const payload = {
		response: {
			sections: [
				{
					hits: [
						{ result: { id: 1, title: "a", full_title: "a", url: "u", artist_names: "x", annotation_count: 5 } },
						{ result: { id: 2, title: "b", full_title: "b", url: "u", artist_names: "x", annotation_count: 5 } },
					],
				},
			],
		},
	};
	assert.deepEqual(parseSearchResults(payload).map((hit) => hit.id), [1, 2]);
});

test("parseSearchResults defaults the new fields on sparse rows", () => {
	const hits = parseSearchResults({ response: { sections: [{ hits: [{ result: { id: 5, title: "t", url: "u", artist_names: "a" } }] }] } });
	assert.equal(hits[0].annotationCount, 0);
	assert.equal(hits[0].translation, false);
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
				children: [{ tag: "p", children: ["Two buffalo gals go around the outside", { tag: "br" }, "Round the outside"] }],
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
					{ tag: "a", attributes: { href: "https://genius.com/artists/Obie-trice" }, children: ["Obie Trice"] },
					"’s label ",
					{ tag: "a", attributes: { href: "https://genius.com/artists/Shady-records" }, children: ["Shady Records"] },
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

test("parseNoteBlocks keeps an outbound link inside the sentence it supports", () => {
	// "As Trice confirmed" links "confirmed" to a clip. Pulling it out as its own
	// line lost the sentence it was evidence for.
	const blocks = parseNoteBlocks({
		tag: "root",
		children: [
			{
				tag: "p",
				children: [
					"As Trice ",
					{ tag: "a", attributes: { href: "https://youtu.be/-R45HPkUPck?t=58" }, children: ["confirmed"] },
					" it in a ‘Making Of’ clip.",
				],
			},
		],
	});

	assert.equal(blocks.length, 1);
	const paragraph = blocks[0] as { kind: "paragraph"; spans: Array<{ text: string; href?: string }> };
	assert.deepEqual(paragraph.spans, [
		{ text: "As Trice " },
		{ text: "confirmed", href: "https://youtu.be/-R45HPkUPck?t=58" },
		{ text: " it in a ‘Making Of’ clip." },
	]);
});

test("domToText keeps paragraph breaks but not inline ones", () => {
	const text = domToText({
		tag: "root",
		children: [
			{ tag: "p", children: ["First paragraph."] },
			{ tag: "p", children: ["Second paragraph with ", { tag: "em", children: ["emphasis"] }, " kept inline."] },
		],
	});
	assert.equal(text, "First paragraph.\nSecond paragraph with emphasis kept inline.");
});

test("parseReferent reaches the blocks through body.dom", () => {
	// The prose lives at body.dom, not body. Reading the wrong level yields an
	// empty block list while the flat text still looks fine, which is exactly the
	// shape of the bug: notes rendered as one run-on paragraph.
	const annotation = parseReferent(
		{
			response: {
				referent: {
					classification: "accepted",
					fragment: "x",
					annotations: [
						{
							votes_total: 326,
							body: {
								dom: {
									tag: "root",
									children: [
										{ tag: "p", children: ["First point."] },
										{ tag: "blockquote", children: [{ tag: "p", children: ["A quoted line"] }] },
										{ tag: "img", attributes: { src: "https://images.rapgenius.com/a.jpg", alt: "" } },
									],
								},
							},
						},
					],
				},
			},
		},
		"1",
	);

	assert.deepEqual(annotation.blocks.map((block) => block.kind), ["paragraph", "quote", "image"]);
	assert.match(annotation.text, /First point\./);
});

test("parseLyricLines joins a song split across several containers", () => {
	// Genius splits a long song into consecutive containers rather than one long
	// one. Reading only the first truncated "Without Me" at 38 of 121 lines, right
	// after its first verse, so every annotated block has to be read.
	const lines = parseLyricLines(lyricsPage());
	assert.ok(lines.length > 100, `expected the whole song, got ${lines.length} lines`);
	assert.equal(lines[0].text.startsWith("[Intro:"), true, "starts at the first section");
	assert.equal(lines[lines.length - 1].text, "Kids", "reaches the last line");
});

test("parseLyricLines puts no gap between joined containers", () => {
	// The blocks continue straight into each other, so the seam must be invisible:
	// no lyric is dropped and no empty line is invented at the join.
	const lines = parseLyricLines(lyricsPage());
	// A blank is only ever a section break, and only ever one in a row, so a pair
	// of adjacent non-blank, non-empty lines is a real lyric-to-lyric transition.
	for (const [index, line] of lines.entries()) {
		if (line.text.length === 0) continue;
		const previous = lines[index - 1];
		if (!previous || previous.text.length === 0) continue;
		assert.ok(previous.text !== "" && line.text !== "");
	}
	// The only empty lines are the deliberate spacers.
	for (const line of lines) {
		if (line.text.length === 0) assert.equal(line.blank, true, "unexpected empty line");
	}
});

test("parseLyricLines still ignores the plain-text duplicate after the song", () => {
	// The fixture ends with an un-annotated copy of the first block. It must not be
	// appended, or the song would appear to repeat from the top. The check avoids
	// matching any lyric: a repeated line is normal in a chorus, but a repeated
	// *stretch* is not, so the whole sequence is compared instead.
	const lines = parseLyricLines(lyricsPage());
	const texts = lines.map((line) => line.text);

	const firstLines = texts.slice(0, 6);
	const doubled = texts.some((text, index) => index > 6 && firstLines.every((head, offset) => texts[index + offset] === head));
	assert.equal(doubled, false, "the song's opening was appended twice");
});
