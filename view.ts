/*
 * View model for the lyrics view.
 *
 * Kept apart from the React tree so the interesting part — deciding which
 * annotation is shown for a line, and which line is the active one — can be
 * tested without a renderer. The component in mod.tsx only maps this to DOM.
 */

import type { Annotation, LyricLine } from "./logic.ts";
import { normalize } from "./logic.ts";

export interface LineView {
	index: number;
	text: string;
	/** Annotations anchored to this line, in page order. */
	notes: Annotation[];
	/** True when the line carries at least one note, i.e. it is clickable. */
	annotated: boolean;
	/** Spotify's start offset, when a synced axis was found. */
	startTimeMs?: number;
	/**
	 * True on the line that opens the note, false on the lines it continues over.
	 * The span is highlighted as one region, so any line in it can open the note.
	 */
	noteStart?: boolean;
	/** A blank line Genius puts before a section header. */
	blank?: boolean;
	/**
	 * Ids of every note whose highlighted region covers this line, whether or not
	 * the line itself opens one. Hovering any of them lights the whole run, which
	 * is what makes a spanning note read as one marked region.
	 */
	spanIds?: string[];
}

export interface TrackView {
	title: string;
	artist: string;
	/** Lines in display order. */
	lines: LineView[];
	/** Number of lines with at least one annotation. */
	annotatedCount: number;
	/** Where the lyrics came from, shown in the footer. */
	source: "genius" | "spotify" | "none";
	/** Set when Genius has the song but no annotations for it. */
	annotationless?: boolean;
}

export interface BuildInput {
	title: string;
	artist: string;
	/** Genius lines with their anchors; the primary source. */
	lines?: LyricLine[];
	/** Annotations keyed by referent id. */
	notes?: Map<string, Annotation>;
	/** Spotify's timing axis, matched onto the Genius lines by text. */
	timing?: Array<{ text: string; startTimeMs?: number }>;
	/** Set when Genius had the song but reported no annotations. */
	annotationless?: boolean;
}

/**
 * Attach Spotify's timing to Genius' lines.
 *
 * Genius supplies the text and the anchors; Spotify supplies the clock. They
 * are separate copies of the same song and are matched on normalized text.
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
	timing,
	annotationless,
}: BuildInput): TrackView => {
	const timed = applyTiming(lines, timing);

	// A spanning note covers a run of consecutive lines, so the run's ids are
	// collected per line and shared with the lines that continue it. This is what
	// lets hovering any line of a multi-line note light all of it.
	const views: LineView[] = [];
	const spanOf = (index: number): string[] => {
		const own = views[index]?.notes.map((note) => note.referentId) ?? [];
		if (own.length > 0) return own;

		// A line with no note of its own is a continuation only when the parser said
		// so. It attaches the anchor it inherited to every line inside a span, so
		// "no note" alone cannot tell a continuation from an ordinary lyric that
		// merely follows one, and treating them alike lights the wrong region.
		if (views[index]?.noteStart !== false) return own;

		// Step over a blank spacer, which is layout rather than a line of the song.
		let opener = views[index - 1];
		if (opener?.blank) opener = views[index - 2];
		return opener?.notes.map((note) => note.referentId) ?? own;
	};

	views.push(...timed.map((line, index) => {
		// Every line of a spanning anchor resolves to the same note, so each of them
		// can show it; which one opens the popup is decided by noteStart.
		const attached = line.referentIds
			.map((id) => notes.get(id))
			.filter((note): note is Annotation => Boolean(note?.text));
		const unique = [...new Map(attached.map((note) => [note.referentId, note])).values()];
		return {
			index,
			text: line.text,
			notes: unique,
			annotated: unique.length > 0,
			startTimeMs: line.startTimeMs,
			noteStart: line.noteStart,
			blank: line.blank,
		};
	}));

	// Second pass: the opener of a span is known only once every line exists, so a
	// continuation line can be told which region it belongs to.
	for (const [index, view] of views.entries()) {
		view.spanIds = spanOf(index);
	}

	const annotatedCount = views.filter((view) => view.annotated).length;

	return {
		title,
		artist,
		lines: views,
		annotatedCount,
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
