/*
 * Client-free parsing for Genius' payloads.
 *
 * Everything here is pure: no /modules/* import, no client global, no network.
 * That keeps it runnable under `node --test` and keeps the transport layer
 * (genius.ts) swappable — the endpoints below are Genius' own web-internal
 * JSON APIs, which need no OAuth and send no CORS headers.
 */

/** A node in Genius' lyrics DOM. Children are strings or nested nodes. */
export interface GeniusDomNode {
	tag?: string;
	children?: Array<GeniusDomNode | string>;
	attributes?: Record<string, string>;
	data?: Record<string, unknown>;
}

/**
 * Flatten Genius' DOM into plain text.
 *
 * Genius marks hard line breaks with <br>, so a break is a line boundary
 * while nested nodes are not. lyrics-plus joins children with "\n" at the
 * top level only (getChildDeep's isDeep flag); this reproduces that.
 */
/** Tags that end a block, so the next one starts on its own line. */
const BLOCK_TAGS = new Set(["p", "div", "blockquote", "h1", "h2", "h3", "h4", "li", "ul", "ol", "pre"]);

/**
 * Flatten Genius' prose DOM into plain text that keeps the author's layout.
 *
 * Annotations are written as prose: paragraphs, quoted lyric excerpts in
 * <blockquote>, album and artist names wrapped in <a>, <em> for foreign titles,
 * <br> for hard breaks and the occasional <img>. Flattening every node to text
 * ran all of it together, which is why notes read as a wall of sentences where
 * Genius shows distinct paragraphs and indented quotes.
 *
 * Only the structure is preserved, not the styling: links keep their text, and
 * an image becomes a short marker rather than being dropped silently. Tags that
 * only carry formatting (em, strong, sup) are transparent, so an italic album
 * title does not break the line.
 */
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
			// Alt text is usually empty and a bare marker would read as noise, so
			// say there was an image and leave it at that.
			const alt = child.attributes?.alt?.trim();
			parts.push(alt ? `[${alt}]` : "[image]");
			continue;
		}

		const inner = domToText(child);

		if (tag === "blockquote") {
			// Quote the excerpt's own lines with a marker so a sampled lyric reads
			// as quoted rather than as more of the annotation's argument.
			const quoted = inner.split("\n").map((line) => (line.trim() ? `> ${line.trim()}` : ">"));
			parts.push(`\n${quoted.join("\n")}\n`);
			continue;
		}

		parts.push(BLOCK_TAGS.has(tag) ? `${inner}\n` : inner);
	}

	return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
};

/**
 * Reduce text to comparable letters.
 *
 * Genius' fragments are de-accented and de-punctuated, and they drop the
 * apostrophe entirely: its referent for "Conect, dn't run dry" reads
 * "Conect dnt run dry". Keeping apostrophes here made every contraction fail
 * to match, so they go too. Exported because matching Spotify's copy of a
 * line against Genius' has to fold text the same way.
 */
export const normalize = (value: string) =>
	value
		.toLowerCase()
		.replace(/[‘’]/g, "")
		.replace(/[“”]/g, "")
		.replace(/[^a-z0-9\n]/g, "");

/** Strip the decorations a Spotify title carries that only hurt a comparison. */
export const cleanTitleText = (title: string) =>
	title
		.replace(/\s*[-–—]\s*(remaster|remastered|version|edit|mix|live|mono|stereo).*$/i, "")
		.replace(/\s*[\(\[].*?[\)\]]\s*$/g, "")
		.trim();

export interface Annotation {
	/** Referent id, taken from the first numeric path segment. */
	referentId: string;
	/** The lyric fragment this annotation is anchored to. */
	fragment: string;
	/** Annotation body as plain text, kept for previews and emptiness checks. */
	text: string;
	/** The body as renderable blocks, since annotations are structured prose. */
	blocks: NoteBlock[];
	/**
	 * True when the artist wrote the note themselves, which Genius marks as
	 * verified. The site tints those yellow instead of grey, so the panel does.
	 */
	verified: boolean;
	/** Where the body came from, which decides precedence. */
	source: "referent" | "annotation" | "none";
	/**
	 * Genius users credited on the annotation, strongest attribution first.
	 * A single annotation is routinely co-signed by several people, so this is a
	 * list rather than one name.
	 */
	authors: string[];
	/** Upvotes on the annotation, which is how Genius ranks its own front page. */
	votes?: number;
}

/** The prose DOM inside an annotation body, which is nested under `dom`. */
const bodyOf = (entry: Record<string, unknown> | undefined): GeniusDomNode | undefined =>
	(entry?.body as { dom?: GeniusDomNode } | undefined)?.dom;

const readDom = (value: unknown): string => {
	if (!value || typeof value !== "object") return "";
	return domToText((value as { dom?: GeniusDomNode }).dom);
};

/**
 * Build an annotation from a referent payload.
 *
 * The referent carries the artist's own annotation, which is authoritative; a
 * bare annotation payload covers the referents Genius serves without that list.
 */
export const parseReferent = (payload: unknown, referentId: string): Annotation => {
	const response = (payload as { response?: Record<string, unknown> })?.response ?? {};
	const referent = (response.referent ?? {}) as Record<string, unknown>;
	const fragment = typeof referent.fragment === "string" ? referent.fragment : "";
	/**
	 * Which endpoint served the body decides where the verified flag survives:
	 * referents/ reports it on both the referent and its annotation, but
	 * annotations/ — the fallback — keeps it only on the referent, and reports
	 * the annotation as merely accepted. Reading both is what keeps a verified
	 * note yellow either way.
	 */
	const verified = referent.classification === "verified";

	// Prefer the referent's own annotation list; fall back to a standalone
	// annotation payload for referents Genius serves without the list attached.
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

	// The credited writers live in `authors`, ordered by how much of the
	// annotation each contributed. `annotator_login` is the Genius account that
	// created the *referent*, which is a moderator handle rather than the writer
	// — using it credited every note on a track to whoever happened to open it.
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
	/** True when Genius marks this entry as a translation of another song. */
	translation: boolean;
}

/**
 * Recognise a translation from its title.
 *
 * Genius writes these in many languages and the marker lands in different
 * places: "(polskie tłumaczenie)", "(türkçe çeviri)", "(Deutsche Übersetzung)",
 * "(transcription)" — and sometimes only in the artist field, as in
 * "by Genius Türkçe Çeviriler". The giveaway is a parenthesised phrase naming a
 * language or translation, or an artist/URL that says so.
 */
const TRANSLATION_WORDS =
	/translat|tłumaczen|übersetz|bersetz|ceviri|çeviri|tradu|traduc|versi[oó]n|tradu[cç]|\bcevir|\btranscri/i;

const isTranslationTitle = (title: string): boolean =>
	/\([^)]*\)/.test(title) && TRANSLATION_WORDS.test(title);

const mentionsTranslation = (value: string): boolean =>
	TRANSLATION_WORDS.test(value) && /\b(?:translations?|tłumaczenia|übersetzungen|traducciones|ceviriler|çeviriler)\b/i.test(value);

/**
 * Pull the candidate songs out of /api/search/song, best match first.
 *
 * Genius mixes original songs with community translations in one result list,
 * and the translations often outrank the original: searching "Rihanna Genius"
 * returned six Polish and Turkish translations before the English original. A
 * translation carries its own annotations, so taking the first hit would show a
 * translated text whose notes are about a different language's wording.
 *
 * Ranking therefore puts annotated originals ahead of everything else, keeps
 * unannotated originals ahead of translations, and only uses Genius' own order
 * to break ties.
 */
/**
 * Turn a refused Genius response into an error instead of an empty result.
 *
 * A refusal carries only a status, which would otherwise read as "this matched
 * nothing" — reporting a song as absent from Genius when Genius never answered.
 */
export const throwIfGeniusRefused = (payload: unknown): void => {
	const code = (payload as { code?: unknown } | null | undefined)?.code;
	if (typeof code !== "number" || code < 400) return;
	throw new Error(
		code === 429
			? "Genius rate limit reached (429). Try again in a moment."
			: `Genius refused the request (${code}).`,
	);
};

export const parseSearchResults = (payload: unknown): SongHit[] => {
	// A refused request has no sections, which would read as "matched nothing".
	throwIfGeniusRefused(payload);

	const sections = (payload as { response?: { sections?: Array<Record<string, unknown>> } })?.response
		?.sections;
	if (!Array.isArray(sections)) return [];

	const hits: SongHit[] = [];
	for (const section of sections) {
		for (const hit of (section.hits ?? []) as Array<Record<string, unknown>>) {
			const result = hit.result as Record<string, unknown> | undefined;
			if (!result || typeof result.id !== "number") continue;

			const fullTitle = typeof result.full_title === "string" ? result.full_title : "";
			const title = typeof result.title === "string" ? result.title : "";
			// full_title reads "Rihanna - S&M (polskie tłumaczenie) by Polskie tłumaczenia
			// Genius", so the translation marker sits outside `title` alone.
			const translation =
				typeof result.translation_url === "string" ||
				isTranslationTitle(title) ||
				isTranslationTitle(fullTitle) ||
				mentionsTranslation(String(result.artist_names ?? "")) ||
				TRANSLATION_WORDS.test(fullTitle.split(" by ")[1] ?? "");

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
				translation,
			});
		}
	}

	// Being the original text matters more than having notes: a translation's
	// annotations explain that language's wording, which is not what a listener
	// playing the original asked for. Annotation count only breaks ties within
	// the same kind of entry. The sort is stable so Genius' relevance ordering
	// survives inside a tier.
	const rank = (hit: SongHit) => (hit.translation ? 2 : 1) * 2 - (hit.annotationCount > 0 ? 1 : 0);
	return hits
		.map((hit, index) => ({ hit, index }))
		.sort((a, b) => rank(a.hit) - rank(b.hit) || a.index - b.index)
		.map((entry) => entry.hit);
};

/**
 * Pick the search hit that is actually this track.
 *
 * Genius' order can put a same-titled song by another artist first.
 */
export const pickHit = (hits: SongHit[], title: string, artist: string): SongHit | null => {
	if (hits.length === 0) return null;

	const wanted = normalize(cleanTitleText(title));
	const wantedArtist = normalize(artist);

	const score = (hit: SongHit) => {
		let value = 0;
		const hitTitle = normalize(cleanTitleText(hit.title));
		if (wanted && hitTitle) {
			if (hitTitle === wanted) value += 4;
			else if (hitTitle.includes(wanted) || wanted.includes(hitTitle)) value += 2;
		}
		// Genius lists several names joined, so containment on the normalized form.
		if (wantedArtist && normalize(hit.artist).includes(wantedArtist)) value += 2;
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
	 * Genius' editorial notes about the song, not the lyrics.
	 *
	 * description.dom is prose ("According to Thom Yorke, ..."), so it is
	 * useful context but must never be treated as lyric lines: aligning
	 * annotations against it would attach every note to the wrong text.
	 */
	description: string;
}

/**
 * Read the song payload.
 *
 * Note what this does NOT return: lyrics. Genius keeps lyrics out of this
 * payload entirely — description.dom holds the editor's prose. The actual
 * lyric lines only exist in the rendered page, so callers need
 * parseLyricLines() for those.
 */
export const parseSong = (payload: unknown): GeniusSong | null => {
	const song = (payload as { response?: { song?: Record<string, unknown> } })?.response?.song;
	if (!song || typeof song.id !== "number") return null;

	const description = song.description as { dom?: GeniusDomNode } | undefined;

	return {
		id: song.id,
		title: typeof song.title === "string" ? song.title : "",
		url: typeof song.url === "string" ? song.url : "",
		annotationCount: typeof song.annotation_count === "number" ? song.annotation_count : 0,
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

/**
 * A lyric line together with the annotations anchored to it.
 *
 * The anchor comes from Genius itself rather than a later guess: in the
 * rendered page each annotated fragment is wrapped in <a href="/<id>/...">, so
 * reading the anchors in document order is the only way to know which line a
 * note belongs to. Matching fragments back to lines by text gets this wrong
 * whenever a song repeats a chorus, and it cannot tell two verses apart.
 */
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
	 *
	 * Genius anchors one referent across consecutive lines when a phrase spans
	 * them, so every line of the span carries the same id while only the first is
	 * marked as the opener. The note is shown once, from that line, and the
	 * continuation lines stay annotated so the whole span reads as one region the
	 * way Genius does.
	 */
	noteStart?: boolean;
	/**
	 * A deliberate blank line. Genius writes these as <br><br> before a section
	 * header, and dropping them made the structure run together.
	 */
	blank?: boolean;
}

const REFERENT_HREF = /href="\/(\d{3,})\//g;

/**
 * Read the annotated lyrics out of a rendered Genius page.
 *
 * Genius renders the lyrics more than once: some copies carry the annotation
 * anchors and others are plain-text duplicates, and a long song is split across
 * several containers. Only the blocks carrying anchors are read, and they are
 * concatenated in document order, which is what makes the whole song appear.
 *
 * Containers are located by scanning openings and then balancing div depth
 * rather than by capturing to the next "</div>": the real containers hold
 * anchors inside inline elements, and a naive slice truncates early whenever a
 * nested div appears. Scanning openings also keeps this linear, where one
 * greedy pattern over a full Genius page spent seconds in backtracking.
 */
export const parseLyricLines = (html: string): LyricLine[] => {
	const openings: number[] = [];
	const openPattern = /<div[^>]*data-lyrics-container="true"[^>]*>/g;
	let open: RegExpExecArray | null;
	while ((open = openPattern.exec(html)) !== null) openings.push(open.index + open[0].length);

	// Genius splits a long song across several containers rather than one long
	// one: "Without Me" arrives as 38 + 30 + 34 + 19 lines that continue straight
	// into each other. Reading only the first container truncated the song at its
	// first verse, so every annotated block is read and they are concatenated in
	// document order.
	//
	// Only blocks carrying referent anchors are taken, which is what separates the
	// real lyrics from the contributor header and the plain-text duplicate. The
	// blocks are not duplicates of each other — verified by hashing their text on
	// two songs — so nothing is repeated by concatenating them.
	const lines: LyricLine[] = [];
	// Ids whose note has already been opened, so a repeated chorus does not
	// attach the same note to every repeat.
	const opened = new Set<string>();

	// Kept unstripped: the duplicate and the chrome block are both fragments of
	// another block's header, and stripping removes the text that shows it.
	const blocks: string[] = [];
	for (const start of openings) {
		const end = findContainerEnd(html, start);
		if (end < 0) continue;
		blocks.push(html.slice(start, end));
	}

	// Genius renders the lyrics twice: once split across containers, once as one
	// plain-text duplicate. Only the first section has anchors, so filtering on
	// anchors kept that section and dropped the rest of the song.
	//
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
		// Split on <br> into display lines and work out which note each belongs to.
		// Four things make this more than a plain split:
		//  - an anchor can wrap a break (<i>line one<br/>line two</i>), so a line
		//    may carry an id opened on an earlier line, or close one;
		//  - Genius writes an empty line before a section header as <br><br>, so
		//    the split produces an empty piece that has to be kept;
		//  - a repeated chorus repeats the same id, and only the first occurrence
		//    should open the note;
		//  - a line can hold several anchors.
		const pieces = lyricBlock.split(/<br\s*\/?>/i);
		const owners: string[][] = [];
		// A span is the run of lines one anchor covers, and only its first line opens
		// the note. `openIds` is the anchor currently open across a break, so a line
		// inside a spanning anchor inherits its id; `spanStarts` records separately
		// whether this line is where the note opens.
		const spanStarts: boolean[] = [];
		// Referent ids whose <a> is still open, so an anchor wrapping a break keeps
		// the lines inside it. A count of opens against closes cannot decide this:
		// an anchor that opens and closes on one line balances to zero and would
		// leak its id onto every line after it.
		let openIds: string[] = [];
		// Emphasis in force when the previous line ended, so a tag wrapping a break
		// keeps styling the lines inside it. Runs are kept as read, since the carry
		// cannot be recomputed without replaying the block.
		let openEmphasis = new Set<string>();
		const runsByLine: LyricRun[][] = [];

		for (const raw of pieces) {
			const { runs, close } = readRuns(raw, openEmphasis);
			openEmphasis = close;
			runsByLine.push(runs);
			// A line that carries an id is the line the note opens on. Genius puts the
			// id on the first line of the span, and a later line that repeats the same
			// id is the start of a fresh span, so this is decided by the id alone
			// rather than by whether some anchor is currently open — the anchor
			// opened above a break only means this line is inside it, and that line
			// must not open anything.
			const ids = collectReferentIds(raw);
			spanStarts.push(ids.length > 0);
			// Every anchor open anywhere in this line, whether opened here or above a
			// break: the text belongs to all of them.
			owners.push([...new Set([...openIds, ...ids])]);

			// What is still open at the end of the line decides the next one. The
			// anchors are walked in document order rather than counted, because the
			// count cannot tell an anchor that closed on its own line — the common
			// case — from one wrapping the break, and getting that wrong carried a
			// note across the rest of the song.
			openIds = stillOpen(raw, openIds);
		}

		for (const [index, raw] of pieces.entries()) {
			const text = plainText(raw);
			const runs = trimRuns(runsByLine[index]);
			// A section header is Genius' own scaffolding, not a lyric, and carries no
			// annotation of its own. The id seen here belongs to the anchor that opens
			// after the break, so letting it through would put a note on the header.
			if (text.length === 0) {
				// A blank line is Genius' own separator between sections, written as
				// <br><br>. It is kept as-is, with no test for what follows: every
				// blank in both sampled songs is followed by a section header, and a
				// rule that inspected the next line would break on any other wording
				// Genius uses.
				//
				// This also covers the blank that ends each container. A long song is
				// split across several containers, so that trailing blank belongs to
				// the header the next container opens with — dropping it is what left
				// every chorus but the first one jammed against the previous line.
				lines.push({ text: "", referentIds: [], blank: true });
				continue;
			}

			// Every line a spanning anchor covers keeps the id, so the region can be
			// highlighted as one piece the way Genius does. `opened` then decides
			// which line fetches and shows the note: an id repeated later in the song
			// is the same note about a repeated phrase and must not open twice, while
			// the lines inside one anchor are all part of the same note and any of
			// them can open it.
			const owned = owners[index];
			const isStart = owned.length > 0 && spanStarts[index];
			for (const id of owned) {
				if (isStart) opened.add(id);
			}
			// Continuations carry an id they inherited, which is what keeps the span
			// highlighted as one block of lines rather than as separate notes.
			// Only carried when something is styled; a plain line keeps just its text.
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

/**
 * Split one line's markup into text runs, keeping italics and bold.
 *
 * Genius marks who sings what with emphasis rather than a separate credit, so
 * stripping the tags made every part of a multi-singer vocal look alike.
 *
 * `open` and `close` are the emphasis in force from the previous line, because a
 * tag can wrap a break, and the run closes where that line ends.
 */
const readRuns = (fragment: string, open: Set<string>): { runs: LyricRun[]; close: Set<string> } => {
	const runs: LyricRun[] = [];
	const active = new Set(open);

	const push = (raw: string) => {
		// Non-emphasis tags are stripped too, or the anchor's own <span>/<a>
		// would be read as words. Asterisks go too: Genius writes emphasis as
		// literal *text* where the markup would not survive, and those are not
		// part of the lyric.
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

/**
 * Drop runs holding no words, and fold whitespace-only runs into their neighbour.
 *
 * A break can leave a run holding only the indentation between tags. Joining the
 * runs must still reproduce `text` exactly, since that is what timing and the
 * notes read.
 */
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

	// Leading and trailing whitespace is the line's own indentation, which `text`
	// trims away.
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

/**
 * Which referent anchors are still open after this line.
 *
 * An anchor that opens and closes on the same line owns only that line; one that
 * wraps a <br/> keeps the lines inside it. Counting opens against closes gets the
 * first case wrong — it balances to zero, so the id was never dropped and the
 * note carried on to every following line — so the tags are walked instead.
 */
const stillOpen = (fragment: string, carried: string[]): string[] => {
	const stack = [...carried];
	ANCHOR_EDGE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ANCHOR_EDGE.exec(fragment)) !== null) {
		if (match[1]) stack.push(match[1]);
		else stack.pop();
	}
	ANCHOR_EDGE.lastIndex = 0;
	// An id opened and closed on this line can survive as a stray entry only if the
	// markup nests unexpectedly; keeping the carried ones that are still open is
	// what the next line needs.
	return stack.filter((id, index) => stack.indexOf(id) === index);
};

/**
 * Cut every data-exclude-from-selection region out of a lyrics block.
 *
 * Genius puts the contributor/translation header and the song blurb inside the
 * same container as the lyrics, and marks them with this attribute — so they
 * can be removed on structure instead of guessed at from line lengths. Guessing
 * was tried and failed twice over: the header became the first "line", and a
 * song with a genuinely long line would be discarded whole.
 *
 * The regions nest divs, so the extent is found by balancing depth rather than
 * by taking the first "</div>" — that stopped early and left the blurb behind as
 * a bogus first line.
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

/**
 * A paragraph inside an annotation, kept apart from the text.
 *
 * Genius' annotations are structured prose — paragraphs, quoted lyric excerpts,
 * embedded images and video links — and flattening them into one string lost
 * that. Rendering needs the blocks, not just a string, so a note carries a
 * `blocks` list alongside the flat `text` kept for length checks and previews.
 */
/** One run of text inside a paragraph, with the links among it preserved. */
export type NoteSpan = { text: string } | { text: string; href: string };

export type NoteBlock =
	| { kind: "paragraph"; spans: NoteSpan[] }
	| { kind: "quote"; lines: NoteSpan[][] }
	| { kind: "image"; src: string };

/**
 * Read one node's worth of prose into spans, keeping links inline.
 *
 * Genius links artists, albums and songs inside sentences, and links outside
 * Genius with the link text as the anchor ("confirmed" pointing at a YouTube
 * clip). Both belong inside the line where they were written — turning them
 * into separate blocks pulled "confirmed" out of "As Trice confirmed" and put it
 * on a line of its own.
 */
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

/**
 * Read an annotation body into renderable blocks.
 *
 * A bare <a> whose text is itself a link (Genius embeds them that way) becomes a
 * video card; an <img> becomes an image block. Everything else falls back to
 * paragraphs, with <blockquote> kept as a quote so a sampled lyric stays
 * distinguishable from the writer's own commentary.
 */
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
