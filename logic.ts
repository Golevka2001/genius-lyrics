/*
 * Pure parsing for Genius' payloads: no client, no network, so it runs under
 * `bun test` and genius.ts stays the only thing that talks to the API.
 */

/** A node in Genius' lyrics DOM. Children are strings or nested nodes. */
export interface GeniusDomNode {
	tag?: string;
	children?: Array<GeniusDomNode | string>;
	attributes?: Record<string, string>;
	data?: Record<string, unknown>;
}

// Tags that end a block, so the next one starts on its own line.
const BLOCK_TAGS = new Set(["p", "div", "blockquote", "h1", "h2", "h3", "h4", "li", "ul", "ol", "pre"]);

// Keeps the author's paragraph and quote structure, which flattening to bare
// text ran together into a wall of sentences. Styling is not kept: links keep
// their text and formatting tags stay transparent.
export const domToText = (node: GeniusDomNode | string | undefined | null): string => {
	if (node === undefined || node === null) return "";
	if (typeof node === "string") return node;

	const parts: string[] = [];

	for (const child of node.children ?? []) {
		if (typeof child === "string") {
			parts.push(child);
			continue;
		}

		const tag = child.tag ?? "";

		if (tag === "br") {
			parts.push("\n");
			continue;
		}

		if (tag === "img") {
			// Alt text is usually empty and a bare marker would read as noise.
			const alt = child.attributes?.alt?.trim();
			parts.push(alt ? `[${alt}]` : "[image]");
			continue;
		}

		const inner = domToText(child);

		if (tag === "blockquote") {
			// Marked so a sampled lyric reads as quoted rather than as more of the
			// annotation's own argument.
			const quoted = inner.split("\n").map((line) => (line.trim() ? `> ${line.trim()}` : ">"));
			parts.push(`\n${quoted.join("\n")}\n`);
			continue;
		}

		parts.push(BLOCK_TAGS.has(tag) ? `${inner}\n` : inner);
	}

	return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
};

// Genius drops the apostrophe outright — its referent for "Conect, dn't run dry"
// reads "Conect dnt run dry" — so keeping one made every contraction fail to match.
export const normalize = (value: string) =>
	value
		.toLowerCase()
		.replace(/[‘’]/g, "")
		.replace(/[“”]/g, "")
		.replace(/[^a-z0-9\n]/g, "");

export const cleanTitleText = (title: string) =>
	title
		.replace(/\s*[-–—]\s*(remaster|remastered|version|edit|mix|live|mono|stereo).*$/i, "")
		.replace(/\s*[\(\[].*?[\)\]]\s*$/g, "")
		.trim();

export interface Annotation {
	referentId: string;
	/** The lyric fragment this annotation is anchored to. */
	fragment: string;
	/** Kept flat for emptiness checks, alongside the renderable blocks. */
	text: string;
	blocks: NoteBlock[];
	/** The artist wrote this one themselves; Genius tints those yellow. */
	verified: boolean;
	/** Which endpoint supplied the body, which decides precedence. */
	source: "referent" | "annotation" | "none";
	/** Credited writers, strongest attribution first: one note is often co-signed. */
	authors: string[];
	votes?: number;
}

const bodyOf = (entry: Record<string, unknown> | undefined): GeniusDomNode | undefined =>
	(entry?.body as { dom?: GeniusDomNode } | undefined)?.dom;

const readDom = (value: unknown): string => {
	if (!value || typeof value !== "object") return "";
	return domToText((value as { dom?: GeniusDomNode }).dom);
};

export const parseReferent = (payload: unknown, referentId: string): Annotation => {
	const response = (payload as { response?: Record<string, unknown> })?.response ?? {};
	const referent = (response.referent ?? {}) as Record<string, unknown>;
	const fragment = typeof referent.fragment === "string" ? referent.fragment : "";
	// Read from both ends: referents/ reports it on the referent and on its
	// annotation, but annotations/ — the fallback — keeps it only on the referent
	// and calls the annotation merely accepted.
	const verified = referent.classification === "verified";

	const annotation = (response.annotation ?? {}) as Record<string, unknown>;
	const referentAnnotations = (referent.annotations ?? []) as Array<Record<string, unknown>>;
	const candidates = referentAnnotations.length > 0 ? referentAnnotations : [annotation];

	let best: Record<string, unknown> = {};
	let source: Annotation["source"] = "none";
	for (const candidate of candidates) {
		if (!readDom(candidate.body)) continue;
		best = candidate;
		source = referentAnnotations.length > 0 ? "referent" : "annotation";
		break;
	}
	const text = readDom(best.body);

	// `authors` holds the credited writers. `annotator_login` is whoever opened
	// the referent, which is a moderator handle, not the writer.
	const credited = [
		...((best.authors as Array<Record<string, unknown>> | undefined) ?? []),
		...((annotation.authors as Array<Record<string, unknown>> | undefined) ?? []),
	];
	const authors = credited
		.map((entry) => (entry?.user as Record<string, unknown> | undefined)?.name)
		.filter((name): name is string => typeof name === "string" && name.length > 0);

	const votes = best.votes_total ?? annotation.votes_total;

	return {
		referentId,
		fragment,
		text,
		blocks: text ? parseNoteBlocks(bodyOf(best) ?? bodyOf(annotation)) : [],
		verified: verified || best.verified === true,
		source,
		authors,
		votes: typeof votes === "number" ? votes : undefined,
	};
};

export interface SongHit {
	id: number;
	title: string;
	url: string;
	artist: string;
	/** Community annotations on Genius; the closest thing to a "real song" signal. */
	annotationCount: number;
}

// A refusal carries only a status, so without this it reads as "matched nothing".
export const throwIfGeniusRefused = (payload: unknown): void => {
	const code = (payload as { code?: unknown } | null | undefined)?.code;
	if (typeof code !== "number" || code < 400) return;
	throw new Error(
		code === 429
			? "Genius rate limit reached (429). Try again in a moment."
			: `Genius refused the request (${code}).`,
	);
};

// Which language a hit is in is settled later, by fetchOriginalSong.
export const parseSearchResults = (payload: unknown): SongHit[] => {
	throwIfGeniusRefused(payload);

	const sections = (payload as { response?: { sections?: Array<Record<string, unknown>> } })?.response
		?.sections;
	if (!Array.isArray(sections)) return [];

	const hits: SongHit[] = [];
	for (const section of sections) {
		for (const hit of (section.hits ?? []) as Array<Record<string, unknown>>) {
			const result = hit.result as Record<string, unknown> | undefined;
			if (!result || typeof result.id !== "number") continue;

			const title = typeof result.title === "string" ? result.title : "";
			hits.push({
				id: result.id,
				title,
				url: typeof result.url === "string" ? result.url : "",
				artist:
					typeof result.artist_names === "string"
						? result.artist_names
						: typeof result.primary_artist_name === "string"
							? result.primary_artist_name
							: "",
				annotationCount: typeof result.annotation_count === "number" ? result.annotation_count : 0,
			});
		}
	}

	// Annotated entries first, Genius' order breaking ties.
	const rank = (hit: SongHit) => (hit.annotationCount > 0 ? 1 : 2);
	return hits
		.map((hit, index) => ({ hit, index }))
		.sort((a, b) => rank(a.hit) - rank(b.hit) || a.index - b.index)
		.map((entry) => entry.hit);
};

// Genius puts a same-titled song by another artist first, so title and artists
// are scored against the track.
export const pickHit = (hits: SongHit[], title: string, artist: string): SongHit | null => {
	if (hits.length === 0) return null;

	const wanted = normalize(cleanTitleText(title));
	// Split on commas: Spotify joins names with ", " where Genius uses " & ", and
	// normalize folds both to one string, so compared whole a two-artist credit
	// reads as an exact match and beats the version actually being played.
	const wantedArtists = artist.split(",").map(normalize).filter(Boolean);

	const score = (hit: SongHit) => {
		let value = 0;
		// Raw first, then stripped: cleanTitleText drops any trailing parenthetical,
		// so "Despacito (Remix)" and "Despacito" would otherwise tie and the remix
		// would win, since Genius ranks it first. A decoration is noise on the
		// Spotify side; on Genius' it names the version.
		const hitTitle = normalize(hit.title);
		const wantedRaw = normalize(title);
		const hitStripped = normalize(cleanTitleText(hit.title));
		if (wanted && hitTitle) {
			if (hitTitle === wantedRaw) value += 4;
			else if (hitStripped === wanted) value += 3;
			else if (hitTitle.includes(wantedRaw) || wantedRaw.includes(hitTitle)) value += 2;
		}
		// Containment, since Genius lists several names joined. Exact equality still
		// outranks it: "Radiohead (Cover Band)" contains "Radiohead".
		const hitArtist = normalize(hit.artist);
		for (const name of wantedArtists) {
			if (hitArtist === name) value += 3;
			else if (hitArtist.includes(name)) value += 2;
		}
		return value;
	};

	let best = hits[0];
	let bestScore = score(best);
	for (const hit of hits.slice(1)) {
		const value = score(hit);
		if (value > bestScore) {
			best = hit;
			bestScore = value;
		}
	}
	// Nothing matched: Genius' order is still a better guess than nothing.
	return bestScore > 0 ? best : hits[0];
};

export interface GeniusSong {
	id: number;
	title: string;
	url: string;
	annotationCount: number;
	/**
	 * Ids of the pages Genius groups with this one as translations of each other,
	 * this page included. Empty for a song nothing has been translated into.
	 */
	translationIds: number[];
	/**
	 * Genius' editorial notes, not the lyrics: description.dom is prose, so
	 * aligning annotations against it would attach every note to the wrong text.
	 */
	description: string;
}

// Genius lists a translation among its own siblings but leaves the original out,
// so the one page absent from the list is the one a listener is shown by default.
// Reading the site's grouping beats matching the title, whose markers are per
// language: "Svensk Översättning" and "歌詞和訳" read as original to any word match.
export const isOriginalSong = (song: GeniusSong): boolean => !song.translationIds.includes(song.id);

// No lyrics here: Genius keeps them out of this payload entirely.
export const parseSong = (payload: unknown): GeniusSong | null => {
	const song = (payload as { response?: { song?: Record<string, unknown> } })?.response?.song;
	if (!song || typeof song.id !== "number") return null;

	const description = song.description as { dom?: GeniusDomNode } | undefined;

	return {
		id: song.id,
		title: typeof song.title === "string" ? song.title : "",
		url: typeof song.url === "string" ? song.url : "",
		annotationCount: typeof song.annotation_count === "number" ? song.annotation_count : 0,
		translationIds: ((song.translation_songs ?? []) as Array<Record<string, unknown>>)
			.map((entry) => entry.id)
			.filter((id): id is number => typeof id === "number"),
		description: domToText(description?.dom),
	};
};

const HTML_ENTITIES: Record<string, string> = {
	"&nbsp;": " ",
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
	"&#39;": "'",
	"&#x27;": "'",
	"&#x2F;": "/",
	"&#47;": "/",
};

const decodeEntities = (value: string) =>
	value
		.replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39|#x27|#x2F|#47);/g, (match) => HTML_ENTITIES[match] ?? match)
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));

// The anchors come from Genius rather than a later guess: each annotated fragment
// is wrapped in <a href="/<id>/...">, and matching fragments to lines by text
// misplaces a note wherever a chorus repeats.
export interface LyricLine {
	text: string;
	/** Styled runs, present only when Genius marked the line up. */
	runs?: LyricRun[];
	/** Referent ids anchored to this line, in document order. */
	referentIds: string[];
	/** Spotify's offset, attached later; absent when Spotify has no lyrics. */
	startTimeMs?: number;
	/**
	 * True on the line where a note begins, false on the lines it continues over.
	 * Genius anchors one referent across consecutive lines when a phrase spans
	 * them, so every line of the span carries the id while only the first opens.
	 */
	noteStart?: boolean;
	/**
	 * A deliberate blank line. Genius writes these as <br><br> before a section
	 * header, and dropping them made the structure run together.
	 */
	blank?: boolean;
}

const REFERENT_HREF = /href="\/(\d{3,})\//g;

/*
 * Genius renders the lyrics more than once: split across containers, plus a
 * plain-text duplicate, and only the anchored copy carries notes. A long song
 * arrives as several containers continuing into each other, so every anchored
 * block is read and concatenated in document order.
 *
 * Containers are found by scanning openings and balancing div depth rather than
 * capturing to the next "</div>": the real ones hold anchors inside inline
 * elements, so a naive slice truncates at the first nested div. Scanning also
 * stays linear, where one greedy pattern over a full page spent seconds
 * backtracking.
 */
export const parseLyricLines = (html: string): LyricLine[] => {
	const openings: number[] = [];
	const openPattern = /<div[^>]*data-lyrics-container="true"[^>]*>/g;
	let open: RegExpExecArray | null;
	while ((open = openPattern.exec(html)) !== null) openings.push(open.index + open[0].length);

	const lines: LyricLine[] = [];

	// Kept unstripped: the duplicate and the chrome block are both fragments of
	// another block's header, and stripping removes the text that shows it.
	const blocks: string[] = [];
	for (const start of openings) {
		const close = findContainerEnd(html, start);
		if (close < 0) continue;
		blocks.push(html.slice(start, close));
	}

	// A block whose text sits inside another block's is the copy. Ties go to the
	// anchored one.
	const raw = blocks.map((block) => plainText(block));
	const anchored = blocks.map((block) => {
		const has = REFERENT_HREF.test(block);
		REFERENT_HREF.lastIndex = 0;
		return has;
	});
	const chosen = blocks.filter(
		(_, index) =>
			!raw.some(
				(other, otherIndex) =>
					otherIndex !== index &&
					other.includes(raw[index]) &&
					(other.length > raw[index].length || anchored[otherIndex]),
			),
	);

	for (const block of chosen) {
		const lyricBlock = stripNonLyricMarkup(block);
		// Split on <br> into display lines. An anchor can wrap a break, so a line
		// may carry an id opened earlier or close one; <br><br> leaves an empty
		// piece that has to be kept; a line can hold several anchors.
		const pieces = lyricBlock.split(/<br\s*\/?>/i);
		const owners: string[][] = [];
		// `openIds` is the anchor currently open across a break, so a line inside a
		// span inherits its id; `spanStarts` records whether this is where it opens.
		const spanStarts: boolean[] = [];
		// The count of opens against closes cannot decide this: an anchor that opens
		// and closes on one line balances to zero and would leak its id onwards.
		let openIds: string[] = [];
		// Emphasis in force when the previous line ended, so a tag wrapping a break
		// keeps styling the lines inside it.
		let openEmphasis = new Set<string>();
		const runsByLine: LyricRun[][] = [];

		for (const raw of pieces) {
			const { runs, close } = readRuns(raw, openEmphasis);
			openEmphasis = close;
			runsByLine.push(runs);
			// A line carrying an id is where its note opens. Decided by the id alone:
			// an anchor opened above a break only means this line is inside that span.
			const ids = collectReferentIds(raw);
			spanStarts.push(ids.length > 0);
			// Every anchor open anywhere in this line, whether opened here or above a
			// break: the text belongs to all of them.
			owners.push([...new Set([...openIds, ...ids])]);

			// Walked in document order rather than counted: a count cannot tell an
			// anchor that closed on its own line from one wrapping the break, and
			// getting that wrong carried a note across the rest of the song.
			openIds = stillOpen(raw, openIds);
		}

		for (const [index, raw] of pieces.entries()) {
			const text = plainText(raw);
			const runs = trimRuns(runsByLine[index]);
			if (text.length === 0) {
				// Genius' own separator between sections, written as <br><br>. Kept
				// without a test for what follows, since a rule reading the next line
				// would break on any other wording Genius uses. This also covers the
				// blank that ends each container, which belongs to the header the next
				// one opens with.
				lines.push({ text: "", referentIds: [], blank: true });
				continue;
			}

			// Every line a span covers keeps the id so the region highlights as one
			// piece; only the opening line is marked as the start.
			const owned = owners[index];
			const isStart = owned.length > 0 && spanStarts[index];
			const emphasised = runs.some((run) => run.italic || run.bold);
			lines.push({
				text,
				referentIds: owned,
				...(emphasised ? { runs } : {}),
				...(owned.length > 0 ? { noteStart: isStart } : {}),
			});
		}
	}

	return lines;
};
/** The readable text of one lyrics block, tags and emphasis asterisks stripped. */
const plainText = (block: string): string =>
	decodeEntities(block.replace(/<[^>]+>/g, ""))
		.replace(/\*/g, "")
		.replace(/\s+/g, " ")
		.trim();

/** One run of a line, carrying whatever emphasis Genius put on it. */
export interface LyricRun {
	text: string;
	italic?: boolean;
	bold?: boolean;
}

/** The emphasis tags Genius uses in a lyrics body, and what each one means. */
const EMPHASIS_TAGS: Record<string, "italic" | "bold"> = {
	i: "italic",
	em: "italic",
	b: "bold",
	strong: "bold",
};

// Genius marks who sings what with emphasis rather than a separate credit, so
// stripping the tags made every part of a multi-singer vocal look alike. `open`
// and `close` carry the emphasis in force across a break.
const readRuns = (fragment: string, open: Set<string>): { runs: LyricRun[]; close: Set<string> } => {
	const runs: LyricRun[] = [];
	const active = new Set(open);

	const push = (raw: string) => {
		// Every tag goes, or the anchor's own <span>/<a> would read as words.
		// Asterisks too: Genius writes emphasis as literal *text* where the markup
		// would not survive, and those are not part of the lyric.
		const text = decodeEntities(raw.replace(/<[^>]+>/g, "")).replace(/\*/g, "");
		if (!text) return;
		const last = runs[runs.length - 1];
		const italic = active.has("italic");
		const bold = active.has("bold");
		if (last && !!last.italic === italic && !!last.bold === bold) last.text += text;
		else runs.push({ text, ...(italic ? { italic: true } : {}), ...(bold ? { bold: true } : {}) });
	};

	let cursor = 0;
	let match: RegExpExecArray | null;
	EMPHASIS_PATTERN.lastIndex = 0;
	while ((match = EMPHASIS_PATTERN.exec(fragment)) !== null) {
		const kind = EMPHASIS_TAGS[match[2].toLowerCase()];
		push(fragment.slice(cursor, match.index));
		if (match[1]) active.delete(kind);
		else active.add(kind);
		cursor = match.index + match[0].length;
	}
	push(fragment.slice(cursor));

	return { runs, close: active };
};

const EMPHASIS_PATTERN = /<(\/?)(i|em|b|strong)(\s[^>]*)?>/gi;

// Joining the runs must still reproduce `text` exactly, since that is what
// timing and the notes read.
const trimRuns = (runs: LyricRun[]): LyricRun[] => {
	const kept = runs.filter((run) => run.text.trim().length > 0);
	if (kept.length === 0) return [];

	// Whitespace between two text runs is the space between two words.
	for (let i = 1; i < runs.length; i++) {
		const run = runs[i];
		if (run.text.trim().length > 0 || run.text.length === 0) continue;
		const previous = kept[kept.indexOf(runs[i - 1])];
		if (previous) previous.text += run.text;
	}

	// Leading and trailing whitespace is the line's own indentation, which
	// `text` trims away.
	kept[0].text = kept[0].text.replace(/^\s+/, "");
	kept[kept.length - 1].text = kept[kept.length - 1].text.replace(/\s+$/, "");
	return kept;
};

const collectReferentIds = (fragment: string): string[] => {
	const ids: string[] = [];
	REFERENT_HREF.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = REFERENT_HREF.exec(fragment)) !== null) {
		if (!ids.includes(match[1])) ids.push(match[1]);
	}
	REFERENT_HREF.lastIndex = 0;
	return ids;
};

/** Both ends of a referent anchor, in one pass so they stay in document order. */
const ANCHOR_EDGE = /<a\b[^>]*href="\/(\d{3,})\/[^"]*"|<\/a>/g;

// An anchor that opens and closes on one line owns only that line; one wrapping a
// <br/> keeps the lines inside it. Counting opens against closes gets the first
// case wrong — it balances to zero, so the id was never dropped and the note ran
// on to every following line — hence walking the tags.
const stillOpen = (fragment: string, carried: string[]): string[] => {
	const stack = [...carried];
	ANCHOR_EDGE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ANCHOR_EDGE.exec(fragment)) !== null) {
		if (match[1]) stack.push(match[1]);
		else stack.pop();
	}
	ANCHOR_EDGE.lastIndex = 0;
	// An id opened and closed here survives only if the markup nests unexpectedly.
	return stack.filter((id, index) => stack.indexOf(id) === index);
};

/*
 * The contributor/translation header and the song blurb sit in the same container
 * as the lyrics, marked with this attribute — so they go on structure rather than
 * on line length, which guessed wrong twice: the header became the first "line",
 * and a genuinely long line lost its whole song.
 *
 * The regions nest divs, so the extent comes from balancing depth rather than the
 * first "</div>", which stopped early and left the blurb behind.
 */
const stripNonLyricMarkup = (block: string): string => {
	const open = /<div[^>]*data-exclude-from-selection="true"[^>]*>/gi;
	let result = block;
	let match: RegExpExecArray | null;

	while ((match = open.exec(result)) !== null) {
		const end = findContainerEnd(result, match.index + match[0].length);
		if (end < 0) break;
		result = result.slice(0, match.index) + result.slice(end);
		// Restart the scan on the shortened string so indices stay valid.
		open.lastIndex = 0;
	}

	return result;
};

/** Walk div depth from an opening tag to its matching close. */

const findContainerEnd = (html: string, start: number): number => {
	const tagPattern = /<(\/?)div\b[^>]*>/g;
	tagPattern.lastIndex = start;
	let depth = 1;
	let match: RegExpExecArray | null;

	while ((match = tagPattern.exec(html)) !== null) {
		if (match[1] === "/") {
			depth -= 1;
			if (depth === 0) return match.index;
		} else if (!match[0].endsWith("/>")) {
			depth += 1;
		}
	}
	return -1;
};

export interface SpotifyLyrics {
	synced: boolean;
	lines: Array<{ text: string; startTimeMs?: number }>;
}

/** Read Spotify's own color-lyrics payload, which carries the timing axis. */
export const parseSpotifyLyrics = (payload: unknown): SpotifyLyrics | null => {
	const lyrics = (payload as { lyrics?: Record<string, unknown> })?.lyrics;
	if (!lyrics) return null;

	const synced = lyrics.syncType === "LINE_SYNCED";
	const lines = (lyrics.lines ?? []) as Array<Record<string, unknown>>;

	return {
		synced,
		lines: lines.map((line) => ({
			text: typeof line.words === "string" ? line.words : "",
			startTimeMs: typeof line.startTimeMs === "number" ? line.startTimeMs : undefined,
		})),
	};
};

/** One run of text inside a paragraph, with the links among it preserved. */
export type NoteSpan = { text: string } | { text: string; href: string };

// Annotations are structured prose — paragraphs, quoted excerpts, embedded images
// — and flattening them into one string lost that, so a note carries the blocks
// alongside the flat text kept for emptiness checks.
export type NoteBlock =
	| { kind: "paragraph"; spans: NoteSpan[] }
	| { kind: "quote"; lines: NoteSpan[][] }
	| { kind: "image"; src: string };

// Links stay inline: Genius links artists and albums inside sentences, and an
// outbound one carries its text as the anchor ("confirmed" pointing at a clip).
// Split into separate blocks pulled "confirmed" out of "As Trice confirmed".
const readSpans = (node: GeniusDomNode | string | undefined | null): NoteSpan[] => {
	if (node === undefined || node === null) return [];
	if (typeof node === "string") return node ? [{ text: node }] : [];

	const spans: NoteSpan[] = [];
	for (const child of node.children ?? []) {
		if (typeof child === "string") {
			if (child) spans.push({ text: child });
			continue;
		}

		if (child.tag === "br") {
			spans.push({ text: "\n" });
			continue;
		}

		if (child.tag === "img") {
			// Images sit outside the text run; parseNoteBlocks lifts them out.
			continue;
		}

		const inner = readSpans(child);
		const href = child.tag === "a" ? (child.attributes?.href ?? "") : "";

		// An anchor without a destination is just emphasis.
		if (!href) {
			spans.push(...inner);
			continue;
		}

		for (const span of inner) spans.push({ text: span.text, href });
	}
	return spans;
};

/** Join a line's spans into one string, dropping the links. */
const spansToText = (spans: NoteSpan[]): string =>
	spans.map((span) => span.text).join("").replace(/\n+/g, "\n").trim();

// A bare <a> whose text is itself a link (Genius embeds them that way) becomes a
// video card. <blockquote> stays a quote so a sampled lyric remains
// distinguishable from the writer's own commentary.
export const parseNoteBlocks = (node: GeniusDomNode | string | undefined | null): NoteBlock[] => {
	if (!node || typeof node === "string") {
		const text = typeof node === "string" ? node.trim() : "";
		return text ? [{ kind: "paragraph", spans: [{ text }] }] : [];
	}

	const blocks: NoteBlock[] = [];

	for (const child of node.children ?? []) {
		if (typeof child === "string") continue;

		const tag = child.tag ?? "";

		if (tag === "img") {
			const src = child.attributes?.src ?? "";
			if (src) blocks.push({ kind: "image", src });
			continue;
		}

		if (tag === "blockquote") {
			// A hard break inside the quote splits it into its own lines; a nested
			// <p> already does, so only <br> needs handling here.
			const lines = readSpans(child)
				.reduce<NoteSpan[][]>((acc, span) => {
					if (span.text === "\n") acc.push([]);
					else acc[acc.length - 1]?.push({ ...span, text: span.text.trim() });
					return acc;
				}, [[]])
				.filter((spans) => spansToText(spans));
			if (lines.length > 0) blocks.push({ kind: "quote", lines });
			continue;
		}

		if (tag === "p" || tag === "div") {
			// A paragraph can hold an image, so lift those out and keep the rest.
			const inner = parseNoteBlocks(child);
			const images = inner.filter((block) => block.kind === "image");
			const spans = readSpans(child);

			if (spansToText(spans)) blocks.push({ kind: "paragraph", spans });
			for (const image of images) blocks.push(image);
			continue;
		}

		const spans = readSpans(child);
		if (spansToText(spans)) blocks.push({ kind: "paragraph", spans });
	}

	return blocks;
};
