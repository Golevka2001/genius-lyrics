/*
 * View model for the lyrics view.
 *
 * Kept apart from the React tree so the interesting part — deciding which
 * annotation is shown for a line, and which line is the active one — can be
 * tested without a renderer. The component in mod.tsx only maps this to DOM.
 */

import type { Annotation, LyricLine, LyricRun } from "./logic.ts";
import { normalize } from "./logic.ts";

export interface LineView {
	index: number;
	text: string;
	/** Styled runs, when Genius marked the line up. */
	runs?: LyricRun[];
	/** Annotations anchored to this line, in page order. */
	notes: Annotation[];
	/** Referent ids anchored to this line, whether or not a note has landed. */
	referentIds: string[];
	/** True when the line carries at least one note, i.e. it is clickable. */
	annotated: boolean;
	/**
	 * True once every referent on this line has been answered, whether or not
	 * any of them carried a body. False means the notes are still in flight, and
	 * the panel must not read the empty note list as "there is nothing here".
	 */
	resolved: boolean;
	/**
	 * True when Genius verified any note on this line. A verified note is one
	 * the artist wrote themselves, and it is the one kind the site singles out.
	 */
	verified: boolean;
	/** Spotify's start offset, when a synced axis was found. */
	startTimeMs?: number;
	/** True where the note opens, false on the lines it continues over. */
	noteStart?: boolean;
	/** A blank line Genius puts before a section header. */
	blank?: boolean;
}

export interface TrackView {
	title: string;
	artist: string;
	/** Lines in display order. */
	lines: LineView[];
	/** Number of lines with at least one annotation. */
	annotatedCount: number;
	/**
	 * How many distinct annotations the song carries. Not the annotated line count:
	 * Genius anchors one note across every line a phrase spans, so one annotation
	 * can light seven lines.
	 */
	annotationCount: number;
	/** Where the lyrics came from, shown in the footer. */
	source: "genius" | "spotify" | "none";
	/** Set when Genius has the song but no annotations for it. */
	annotationless?: boolean;
}

export interface BuildInput {
	title: string;
	artist: string;
	/** Genius lines with their anchors, already carrying Spotify's timing. */
	lines?: LyricLine[];
	/** Annotations keyed by referent id. */
	notes?: Map<string, Annotation>;
	/**
	 * Referent ids that have been answered. An anchor outside this set is still
	 * being fetched, which is what keeps a line clickable while its note loads
	 * instead of waiting for the whole song's worth of them.
	 */
	settled?: Set<string>;
	/** Set when Genius had the song but reported no annotations. */
	annotationless?: boolean;
}

/**
 * Attach Spotify's timing to Genius' lines.
 *
 * Genius supplies the text and the anchors; Spotify supplies the clock. They
 * are separate copies of the same song and are matched on normalized text.
 *
 * Applied once per track rather than per repaint: the notes stream in behind the
 * first paint and rebuild the view several times, and this walks both sides of
 * the match. Its result does not change between those rebuilds.
 *
 * Measured against Bohemian Rhapsody this matched 0 of 24 lines, because Genius
 * merges a line where Spotify splits it per clause and Spotify omits the
 * intro, so the two texts diverge from the first line onward. A line that does
 * match is still worth keeping — it is exact when it happens — but the timeline
 * cannot be relied on for the track as a whole, which is why the view treats it
 * as optional and the panel falls back to plain lyrics.
 *
 * The alternative, which lyrics-plus uses, is to make Spotify's lyrics the
 * timed body and layer annotations on top; that needs a different structure
 * than "Genius lines with anchors", since the anchors index Genius' own copy.
 */
export const applyTiming = (lines: LyricLine[], timing?: Array<{ text: string; startTimeMs?: number }>) => {
	if (!timing || timing.length === 0) return lines;

	// Uses logic.ts's normalize so Genius and Spotify's copies of the same line
	// fold identically (apostrophes dropped, punctuation ignored).
	//
	// Repeated text is queued rather than deduplicated: a chorus appears several
	// times with a different offset each time, and the Genius lines are identical
	// copies of one another, so the only way to pair them is by order of
	// appearance. Taking the first match for every occurrence pinned the second
	// chorus to the first one's offset and stalled the highlight there.
	const queues = new Map<string, number[]>();
	for (const entry of timing) {
		if (entry.startTimeMs === undefined) continue;
		const key = normalize(entry.text);
		if (!key) continue;
		const queue = queues.get(key);
		if (queue) queue.push(entry.startTimeMs);
		else queues.set(key, [entry.startTimeMs]);
	}

	return lines.map((line) => {
		const queue = queues.get(normalize(line.text));
		// Nothing timed this line's text at all: leave it untimed rather than
		// borrowing another line's offset.
		if (!queue || queue.length === 0) return line;
		const startTimeMs = queue.shift() as number;
		return { ...line, startTimeMs };
	});
};

export const buildTrackView = ({
	title,
	artist,
	lines = [],
	notes = new Map(),
	settled = new Set(),
	annotationless,
}: BuildInput): TrackView => {
	// Every line of a spanning anchor carries the same referent id, so this one
	// lookup attaches the note and marks the lines that share it at once — which
	// is what lets hovering any line of a multi-line note light all of it.
	const views: LineView[] = lines.map((line, index) => {
		const attached = line.referentIds
			.map((id) => notes.get(id))
			.filter((note): note is Annotation => Boolean(note?.text));
		const unique = [...new Map(attached.map((note) => [note.referentId, note])).values()];

		// The page says a line is annotated as soon as it carries an anchor, which
		// is why a highlight can go up long before the note behind it arrives. So a
		// line counts as annotated while its referents are outstanding, and only
		// stops counting once they are all answered and none carried a body — an
		// anchor with no annotation must not stay clickable with nothing to show.
		const resolved = line.referentIds.every((id) => settled.has(id));
		const annotated = unique.length > 0 || (line.referentIds.length > 0 && !resolved);

		return {
			index,
			text: line.text,
			runs: line.runs,
			notes: unique,
			referentIds: line.referentIds,
			annotated,
			resolved,
			verified: unique.some((note) => note.verified),
			startTimeMs: line.startTimeMs,
			noteStart: line.noteStart,
			blank: line.blank,
		};
	});

	const annotatedCount = views.filter((view) => view.annotated).length;

	// From the notes, not the anchors: one referent id is repeated across the
	// lines of a span. `notes` is already keyed by id, so nothing to dedupe.
	const annotationCount = notes.size;

	return {
		title,
		artist,
		lines: views,
		annotatedCount,
		annotationCount,
		source: views.length > 0 ? "genius" : "none",
		annotationless: views.length > 0 && annotatedCount === 0 ? true : annotationless,
	};
};

/** Distinguish the states a track can be in, so the view can explain itself. */
export type ViewState = "loading" | "ready" | "no-genius" | "failed";

export interface PanelState {
	state: ViewState;
	track: TrackView | null;
	error?: string;
}

export const INITIAL_STATE: PanelState = { state: "loading", track: null };

/**
 * Index of the line that should be highlighted at a given playback position.
 *
 * Returns -1 when the track has no synced axis, or before the first line
 * starts, so callers can fall back to showing every line plainly.
 *
 * The last line whose offset has passed wins rather than the next one: with
 * sparse offsets a "next line" rule would leave a gap on screen between the two.
 */
export const activeLineIndex = (lines: LineView[], progressMs: number): number => {
	let active = -1;
	for (const [index, line] of lines.entries()) {
		if (line.startTimeMs !== undefined && line.startTimeMs <= progressMs) active = index;
		else if (line.startTimeMs !== undefined && line.startTimeMs > progressMs) break;
	}
	return active;
};

/** Whether a track carries enough timing to follow playback. */
export const hasTimeline = (lines: LineView[]): boolean => lines.some((line) => line.startTimeMs !== undefined);
