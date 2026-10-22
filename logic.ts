/** Pure text matching and Genius/Spotify payload transformations. */

export function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[‘’]/g, "")
		.replace(/[“”]/g, "")
		.replace(/[^\p{L}\p{N}\n]/gu, "");
}

export function cleanTitleText(title: string): string {
	return title
		.replace(/\s*[-–—]\s*(remaster|remastered|version|edit|mix|live|mono|stereo).*$/i, "")
		.replace(/\s*[([].*?[)\]]\s*$/g, "")
		.trim();
}

export type GeniusDomNode = {
	tag?: string;
	children?: Array<GeniusDomNode | string>;
	attributes?: Record<string, string | number>;
	data?: Record<string, unknown>;
};

const BLOCK_TAGS = new Set(["p", "div", "blockquote", "h1", "h2", "h3", "h4", "li", "ul", "ol", "pre"]);

export function domToText(node: GeniusDomNode | string | undefined | null): string {
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
			const alt = String(child.attributes?.alt ?? "").trim();
			parts.push(alt ? `[${alt}]` : "[image]");
			continue;
		}

		const inner = domToText(child);

		if (tag === "blockquote") {
			const quoted = inner.split("\n").map((line) => (line.trim() ? `> ${line.trim()}` : ">"));
			parts.push(`\n${quoted.join("\n")}\n`);
			continue;
		}

		parts.push(BLOCK_TAGS.has(tag) ? `${inner}\n` : inner);
	}

	return parts
		.join("")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

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

function decodeEntities(value: string): string {
	return value
		.replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39|#x27|#x2F|#x27);/g, (match) => HTML_ENTITIES[match] ?? match)
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function bodyOf(entry: Record<string, unknown> | undefined): GeniusDomNode | undefined {
	return (entry?.body as { dom?: GeniusDomNode } | undefined)?.dom;
}

function domOf(value: unknown): GeniusDomNode | undefined {
	return (value as { dom?: GeniusDomNode } | undefined)?.dom;
}

function readDom(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	return domToText((value as { dom?: GeniusDomNode }).dom);
}

export type NoteAuthor = {
	name: string;
	avatar?: string;
};

export type NoteStatus = "verified" | "unreviewed" | "accepted";

// Referents, bios and answers each spell review state differently.
export function noteStatus(state: unknown, verified: unknown, classification?: unknown): NoteStatus {
	const label = typeof state === "string" ? state : "";
	const kind = typeof classification === "string" ? classification : "";

	if (label === "verified" || label === "sourced" || verified === true || kind === "verified") return "verified";
	if (label === "unreviewed" || label === "pending") return "unreviewed";
	return "accepted";
}

export type Annotation = {
	/** Genius' own id; a referent can carry several. */
	id: string;
	referentId: string;
	fragment: string;
	text: string;
	blocks: NoteBlock[];
	verified: boolean;
	status: NoteStatus;
	source: "referent" | "annotation" | "none";
	authors: NoteAuthor[];
	votes?: number;
};

function parseAuthors(...lists: Array<Array<Record<string, unknown>> | undefined>): NoteAuthor[] {
	const credited = lists.flatMap((list) => list ?? []);

	return credited
		.map((entry): NoteAuthor | null => {
			const user = (entry?.user ?? {}) as Record<string, unknown>;
			const name = user.name;
			if (typeof name !== "string" || name.length === 0) return null;

			const avatar = (user.avatar ?? {}) as Record<string, unknown>;
			const small = (avatar.small ?? {}) as Record<string, unknown>;

			return {
				name,
				avatar: typeof small.url === "string" ? small.url : undefined,
			};
		})
		.filter((author): author is NoteAuthor => author !== null);
}

// A referent can carry several annotations, so keep every body, not just the first.
export function parseReferent(payload: unknown, referentId: string): Annotation[] {
	const response = (payload as { response?: Record<string, unknown> })?.response ?? {};
	const referent = (response.referent ?? {}) as Record<string, unknown>;
	const fragment = typeof referent.fragment === "string" ? referent.fragment : "";
	const classification = typeof referent.classification === "string" ? referent.classification : "";

	const annotation = (response.annotation ?? {}) as Record<string, unknown>;
	const referentAnnotations = (referent.annotations ?? []) as Array<Record<string, unknown>>;
	const fromReferent = referentAnnotations.length > 0;
	const candidates = fromReferent ? referentAnnotations : [annotation];

	const notes: Annotation[] = [];
	for (const [index, candidate] of candidates.entries()) {
		const text = readDom(candidate.body);
		if (!text) continue;

		// The fallback endpoint under-reports verification; trust the classification there.
		const status = noteStatus(candidate.state, candidate.verified, fromReferent ? undefined : classification);
		const verified = status === "verified";

		const votes = candidate.votes_total ?? annotation.votes_total;

		notes.push({
			id: candidate.id === undefined || candidate.id === null ? `${referentId}:${index}` : String(candidate.id),
			referentId,
			fragment,
			text,
			blocks: parseNoteBlocks(bodyOf(candidate) ?? bodyOf(annotation)),
			verified,
			status,
			source: fromReferent ? "referent" : "annotation",
			authors: parseAuthors(candidate.authors as Array<Record<string, unknown>> | undefined),
			votes: typeof votes === "number" ? votes : undefined,
		});
	}

	return notes;
}

export type SongHit = {
	id: number;
	title: string;
	url: string;
	artist: string;
	annotationCount: number;
};

export function throwIfGeniusRefused(payload: unknown): void {
	const code = (payload as { code?: unknown } | null | undefined)?.code;
	if (typeof code !== "number" || code < 400) return;
	throw new Error(code === 429 ? "Genius rate limit reached (429)" : `Genius refused the request (${code}).`);
}

export function parseSearchResults(payload: unknown): SongHit[] {
	throwIfGeniusRefused(payload);

	const sections = (payload as { response?: { sections?: Array<Record<string, unknown>> } })?.response?.sections;
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

	const rank = (hit: SongHit) => (hit.annotationCount > 0 ? 1 : 2);
	return hits
		.map((hit, index) => ({ hit, index }))
		.sort((a, b) => rank(a.hit) - rank(b.hit) || a.index - b.index)
		.map((entry) => entry.hit);
}

type HitScore = {
	title: number;
	artist: number;
};

function scoreHit(hit: SongHit, title: string, artist: string): HitScore {
	const wanted = normalize(cleanTitleText(title));
	const wantedRaw = normalize(title);
	const hitTitle = normalize(hit.title);
	const hitStripped = normalize(cleanTitleText(hit.title));

	let titleScore = 0;
	if (wanted && hitTitle) {
		if (hitTitle === wantedRaw) titleScore = 4;
		else if (hitStripped === wanted) titleScore = 3;
		else if (wantedRaw.length >= 3 && (hitTitle.includes(wantedRaw) || wantedRaw.includes(hitTitle)))
			titleScore = 2;
	}

	let artistScore = 0;
	const hitArtist = normalize(hit.artist);
	for (const name of artist.split(",").map(normalize).filter(Boolean)) {
		if (hitArtist === name) artistScore += 3;
		else if (hitArtist.includes(name)) artistScore += 2;
	}

	return { title: titleScore, artist: artistScore };
}

export function pickHit(hits: SongHit[], title: string, artist: string): SongHit | null {
	if (hits.length === 0) return null;

	let best: SongHit = hits[0];
	let bestScore = 0;
	for (const hit of hits) {
		const score = scoreHit(hit, title, artist);
		const value = score.title + score.artist;
		if (value > bestScore) {
			best = hit;
			bestScore = value;
		}
	}
	return bestScore > 0 ? best : null;
}

export function matchesTitleAndArtist(hit: SongHit, title: string, artist: string): boolean {
	const score = scoreHit(hit, title, artist);
	return score.title > 0 && score.artist > 0;
}

export type GeniusSong = {
	id: number;
	title: string;
	artist: string;
	url: string;
	artistUrl?: string;
	translationIds: number[];
	bio: NoteBlock[];
	bioStatus?: NoteStatus;
	bioVotes?: number;
};

// Genius translation pages point back to the original through translationIds.
export function isOriginalSong(song: GeniusSong): boolean {
	return !song.translationIds.includes(song.id);
}

export function parseSong(payload: unknown): GeniusSong | null {
	const song = (payload as { response?: { song?: Record<string, unknown> } })?.response?.song;
	if (!song || typeof song.id !== "number") return null;

	const bio = parseNoteBlocks(domOf(song.description));

	const bioReferent = (song.description_annotation ?? {}) as Record<string, unknown>;
	const bioAnnotations = (bioReferent.annotations ?? []) as Array<Record<string, unknown>>;
	const bioAnnotation = (bioAnnotations[0] ?? {}) as Record<string, unknown>;
	const bioVotes = bioAnnotation.votes_total ?? bioReferent.votes_total;
	const bioStatus = noteStatus(bioAnnotation.state, bioAnnotation.verified, bioReferent.classification);

	return {
		id: song.id,
		title: typeof song.title === "string" ? song.title : "",
		artist:
			typeof song.artist_names === "string"
				? song.artist_names
				: typeof (song.primary_artist as Record<string, unknown> | undefined)?.name === "string"
					? (song.primary_artist as { name: string }).name
					: "",
		url: typeof song.url === "string" ? song.url : "",
		// Genius links the credited artist, not every name in artist_names.
		artistUrl:
			typeof (song.primary_artist as Record<string, unknown> | undefined)?.url === "string"
				? (song.primary_artist as { url: string }).url
				: undefined,
		translationIds: ((song.translation_songs ?? []) as Array<Record<string, unknown>>)
			.map((entry) => entry.id)
			.filter((id): id is number => typeof id === "number"),
		bio: hasProse(bio) ? bio : [],
		bioStatus,
		bioVotes: typeof bioVotes === "number" ? bioVotes : undefined,
	};
}

export type LyricLine = {
	text: string;
	runs?: LyricRun[];
	referentIds: string[];
	startTimeMs?: number;
	noteStart?: boolean;
	blank?: boolean;
};

export type LyricRun = {
	text: string;
	italic?: boolean;
	bold?: boolean;
	referentIds?: string[];
	carriesUp?: boolean;
	carriesDown?: boolean;
};

// Parse Genius's HTML directly so referent ids stay attached to their source lines.
function plainText(block: string): string {
	return decodeEntities(block.replace(/<[^>]+>/g, ""))
		.replace(/\*/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

const REFERENT_HREF = /href="\/(\d{3,})\//g;

const EMPHASIS_TAGS: Record<string, "italic" | "bold"> = {
	i: "italic",
	em: "italic",
	b: "bold",
	strong: "bold",
};

const MARKUP_EDGE = /<a\b[^>]*href="\/(\d{3,})\/[^"]*"[^>]*>|<\/a>|<(\/?)(i|em|b|strong)(\s[^>]*)?>/gi;

type OpenMarks = { ids: string[]; emphasis: Set<string> };

export function sameIds(left: string[] | undefined, right: string[] | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

function trimRuns(runs: LyricRun[]): LyricRun[] {
	if (runs.length === 0) return runs;

	runs[0].text = runs[0].text.replace(/^\s+/, "");
	const last = runs[runs.length - 1];
	last.text = last.text.replace(/\s+$/, "");

	return runs.filter((run) => run.text.length > 0);
}

type ScannedLine = {
	runs: LyricRun[];
	referentIds: string[];
	noteStart: boolean;
	closed: string[];
	close: OpenMarks;
};

// A referent can open and close inside a line, so anchors are read per run.
function scanLine(fragment: string, open: OpenMarks): ScannedLine {
	const runs: LyricRun[] = [];
	const stack = [...open.ids];
	const emphasis = new Set(open.emphasis);
	const closedBeforeText: string[] = [];
	let spoken = false;

	const push = (raw: string) => {
		const text = decodeEntities(raw.replace(/<[^>]+>/g, "")).replace(/\*/g, "");
		if (!text) return;
		spoken = true;

		const italic = emphasis.has("italic");
		const bold = emphasis.has("bold");
		const ids = [...new Set(stack)];

		const last = runs[runs.length - 1];
		if (last && !!last.italic === italic && !!last.bold === bold && sameIds(last.referentIds, ids)) {
			last.text += text;
			return;
		}

		runs.push({
			text,
			...(italic ? { italic: true } : {}),
			...(bold ? { bold: true } : {}),
			...(ids.length > 0 ? { referentIds: ids } : {}),
		});
	};

	let cursor = 0;
	let match: RegExpExecArray | null;
	MARKUP_EDGE.lastIndex = 0;
	while ((match = MARKUP_EDGE.exec(fragment)) !== null) {
		push(fragment.slice(cursor, match.index));
		cursor = match.index + match[0].length;

		if (match[1] !== undefined) {
			if (!stack.includes(match[1])) stack.push(match[1]);
		} else if (match[3] === undefined) {
			const id = stack.pop();
			if (id !== undefined && !spoken) closedBeforeText.push(id);
		} else {
			const kind = EMPHASIS_TAGS[match[3].toLowerCase()];
			if (match[2]) emphasis.delete(kind);
			else emphasis.add(kind);
		}
	}
	push(fragment.slice(cursor));

	const referentIds: string[] = [];
	for (const run of runs) {
		if (!run.referentIds) continue;

		referentIds.push(...run.referentIds);
		// Straight edges where a note runs past a break, rounded where it ends.
		run.carriesUp = run.referentIds.every((id) => open.ids.includes(id));
		run.carriesDown = run.referentIds.every((id) => stack.includes(id) && !closedBeforeText.includes(id));
	}

	const unique = [...new Set(referentIds)];
	const opened = runs.some((run) => run.referentIds && !run.carriesUp);

	return {
		runs: trimRuns(runs),
		referentIds: unique,
		noteStart: opened,
		closed: closedBeforeText,
		close: { ids: [...new Set(stack)], emphasis },
	};
}

// Genius nests lyric containers and repeats some of them without anchors.
function findContainerEnd(html: string, start: number): number {
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
}

function stripNonLyricMarkup(block: string): string {
	const open = /<div[^>]*data-exclude-from-selection="true"[^>]*>/gi;
	let result = block;
	let match: RegExpExecArray | null;

	while ((match = open.exec(result)) !== null) {
		const end = findContainerEnd(result, match.index + match[0].length);
		if (end < 0) break;
		result = result.slice(0, match.index) + result.slice(end);
		open.lastIndex = 0;
	}

	return result;
}

// Keep blank lines, emphasis, and anchors while removing page headers.
export function parseLyricLines(html: string): LyricLine[] {
	const openings: number[] = [];
	const openPattern = /<div[^>]*data-lyrics-container="true"[^>]*>/g;
	let open: RegExpExecArray | null;
	while ((open = openPattern.exec(html)) !== null) openings.push(open.index + open[0].length);

	const lines: LyricLine[] = [];

	const blocks: string[] = [];
	for (const start of openings) {
		const close = findContainerEnd(html, start);
		if (close < 0) continue;
		blocks.push(html.slice(start, close));
	}

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
		const pieces = lyricBlock.split(/<br\s*\/?>/i);
		const scans: ScannedLine[] = [];
		let openMarks: OpenMarks = { ids: [], emphasis: new Set() };

		for (const raw of pieces) {
			const scan = scanLine(raw, openMarks);
			const previous = scans[scans.length - 1];

			// The closing tag comes after the break, so the line above is where the note ends.
			for (const id of scan.closed) {
				for (const run of previous?.runs ?? []) {
					if (run.referentIds?.includes(id)) run.carriesDown = false;
				}
			}

			scans.push(scan);
			openMarks = scan.close;
		}

		for (const [index, raw] of pieces.entries()) {
			const text = plainText(raw);
			if (text.length === 0) {
				lines.push({ text: "", referentIds: [], blank: true });
				continue;
			}

			const scan = scans[index];
			const emphasised = scan.runs.some((run) => run.italic || run.bold);
			const owned = scan.referentIds;

			lines.push({
				text,
				referentIds: owned,
				...(emphasised || owned.length > 0 ? { runs: scan.runs } : {}),
				...(owned.length > 0 ? { noteStart: scan.noteStart } : {}),
			});
		}
	}

	return lines;
}

export type SpotifyLyrics = {
	synced: boolean;
	lines: Array<{ text: string; startTimeMs?: number }>;
};

export function parseSpotifyLyrics(payload: unknown): SpotifyLyrics | null {
	const lyrics = (payload as { lyrics?: Record<string, unknown> })?.lyrics;
	if (!lyrics) return null;

	const synced = lyrics.syncType === "LINE_SYNCED";
	const lines = (lyrics.lines ?? []) as Array<Record<string, unknown>>;

	return {
		synced,
		lines: lines.map((line) => {
			const rawStartTime = line.startTimeMs;
			const startTimeMs =
				typeof rawStartTime === "number"
					? rawStartTime
					: typeof rawStartTime === "string" && rawStartTime.trim() !== ""
						? Number(rawStartTime)
						: undefined;

			return {
				text: typeof line.words === "string" ? line.words : "",
				startTimeMs: startTimeMs !== undefined && Number.isFinite(startTimeMs) ? startTimeMs : undefined,
			};
		}),
	};
}

export type NoteSpan = { text: string } | { text: string; href: string };

export type NoteBlock =
	| { kind: "paragraph"; spans: NoteSpan[] }
	| { kind: "quote"; lines: NoteSpan[][] }
	| { kind: "image"; src: string; width?: number; height?: number }
	| { kind: "youtube"; id: string };

// Read annotation text while preserving inline links and line breaks.
function readSpans(node: GeniusDomNode | string | undefined | null): NoteSpan[] {
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
			continue;
		}

		if (child.tag === "li") {
			spans.push(...readSpans(child), { text: "\n" });
			continue;
		}

		const inner = readSpans(child);
		const href = child.tag === "a" ? String(child.attributes?.href ?? "") : "";

		if (!href) {
			spans.push(...inner);
			continue;
		}

		for (const span of inner) spans.push({ text: span.text, href });
	}
	return spans;
}

function spansToText(spans: NoteSpan[]): string {
	return spans
		.map((span) => span.text)
		.join("")
		.replace(/\n+/g, "\n")
		.trim();
}

// A bio made of nothing but punctuation says no more than an empty one; an image counts.
function hasProse(blocks: NoteBlock[]): boolean {
	return blocks.some((block) => {
		if (block.kind === "image" || block.kind === "youtube") return true;

		const text = block.kind === "paragraph" ? spansToText(block.spans) : block.lines.map(spansToText).join("\n");
		return /[\p{L}\p{N}]/u.test(text);
	});
}

// YouTube thumbnail card.
const YOUTUBE_URL =
	/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*?&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;

function youtubeBlock(spans: NoteSpan[]): NoteBlock | null {
	const text = spansToText(spans).trim();
	if (!text || /\s/.test(text)) return null;
	const id = YOUTUBE_URL.exec(text)?.[1];
	return id ? { kind: "youtube", id } : null;
}

function pushText(blocks: NoteBlock[], spans: NoteSpan[]): void {
	const video = youtubeBlock(spans);
	if (video) blocks.push(video);
	else if (spansToText(spans)) blocks.push({ kind: "paragraph", spans });
}

export function parseNoteBlocks(node: GeniusDomNode | string | undefined | null): NoteBlock[] {
	if (!node || typeof node === "string") {
		const text = typeof node === "string" ? node.trim() : "";
		return text ? [{ kind: "paragraph", spans: [{ text }] }] : [];
	}

	const blocks: NoteBlock[] = [];

	for (const child of node.children ?? []) {
		if (typeof child === "string") continue;

		const tag = child.tag ?? "";

		if (tag === "img") {
			const src = String(child.attributes?.src ?? "");
			if (!src) continue;

			const width = Number(child.attributes?.width);
			const height = Number(child.attributes?.height);
			blocks.push({
				kind: "image",
				src,
				...(Number.isFinite(width) && width > 0 ? { width } : {}),
				...(Number.isFinite(height) && height > 0 ? { height } : {}),
			});
			continue;
		}

		if (tag === "blockquote") {
			const lines = readSpans(child)
				.reduce<NoteSpan[][]>(
					(acc, span) => {
						if (span.text === "\n") acc.push([]);
						else acc[acc.length - 1]?.push({ ...span, text: span.text.trim() });
						return acc;
					},
					[[]],
				)
				.filter((spans) => spansToText(spans));
			if (lines.length > 0) blocks.push({ kind: "quote", lines });
			continue;
		}

		if (tag === "p" || tag === "div") {
			const inner = parseNoteBlocks(child);
			const images = inner.filter((block) => block.kind === "image");
			const spans = readSpans(child);

			pushText(blocks, spans);
			for (const image of images) blocks.push(image);
			continue;
		}

		const spans = readSpans(child);
		pushText(blocks, spans);
	}

	return blocks;
}

export type NoteAnswer = {
	id: string;
	question: NoteBlock[];
	answer: NoteBlock[];
	status: NoteStatus;
	source?: AnswerSource;
	votes?: number;
};

/** A sourced answer quotes the artist, so Genius credits the artist and where they said it. */
export type AnswerSource = {
	artistName: string;
	artistUrl?: string;
	artistImage?: string;
	viaName?: string;
	viaUrl?: string;
};

function parseAnswerSource(value: unknown): AnswerSource | undefined {
	const record = (value ?? {}) as Record<string, unknown>;
	const artist = (record.artist ?? {}) as Record<string, unknown>;
	if (typeof record.artist_name !== "string") return undefined;

	return {
		artistName: record.artist_name,
		artistUrl: typeof artist.url === "string" ? artist.url : undefined,
		artistImage: typeof artist.image_url === "string" ? artist.image_url : undefined,
		viaName: typeof record.source_name === "string" ? record.source_name : undefined,
		viaUrl: typeof record.source_url === "string" ? record.source_url : undefined,
	};
}

export function parseQanda(payload: unknown): NoteAnswer[] {
	throwIfGeniusRefused(payload);

	// /api/questions?song_id={id} replaced the retired /api/songs/{id}/qanda.
	const response = (payload as { response?: { questions?: unknown } })?.response;
	const items = response?.questions;
	if (!Array.isArray(items)) return [];

	const answers: NoteAnswer[] = [];
	for (const [index, item] of items.entries()) {
		const entry = (item ?? {}) as Record<string, unknown>;
		const answerRecord = (entry.answer ?? {}) as Record<string, unknown>;
		// The question body is plain text; only the answer carries a DOM node.
		const question = parseNoteBlocks(typeof entry.body === "string" ? entry.body : undefined);
		const answer = parseNoteBlocks(domOf(answerRecord.body));
		if (question.length === 0 || answer.length === 0) continue;

		const votes = answerRecord.votes_total;
		const source = parseAnswerSource(answerRecord.answer_source);

		answers.push({
			id: typeof entry.id === "number" ? String(entry.id) : `qanda:${index}`,
			question,
			answer,
			// Only a sourced answer carries a state at all; the rest are plain accepted answers.
			status: noteStatus(answerRecord.editorial_state, answerRecord.verified, answerRecord.classification),
			...(source ? { source } : {}),
			votes: typeof votes === "number" ? votes : undefined,
		});
	}

	return answers;
}
