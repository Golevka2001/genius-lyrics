/*
 * View model, kept apart from the React tree so the decisions that matter can be
 * tested without a renderer.
 */

import type { Annotation, LyricLine, LyricRun } from "./logic.ts";
import { normalize } from "./logic.ts";

export interface LineView {
	index: number;
	text: string;
	/** Styled runs, when Genius marked the line up. */
	runs?: LyricRun[];
	/** In page order. */
	notes: Annotation[];
	/** Anchored here, whether or not a note has landed. */
	referentIds: string[];
	/** Carries at least one note, i.e. it is clickable. */
	annotated: boolean;
	/**
	 * True once every referent here has been answered, whether or not any carried
	 * a body. False means the notes are in flight, and an empty list must not then
	 * read as "there is nothing here".
	 */
	resolved: boolean;
	/** True when Genius verified any note on this line, i.e. the artist wrote it. */
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
	lines: LineView[];
	annotatedCount: number;
	/**
	 * Distinct annotations the song carries. Not the annotated line count: Genius
	 * anchors one note across every line a phrase spans, so one annotation can
	 * light seven lines.
	 */
	annotationCount: number;
	/** Where the lyrics came from, shown in the footer. */
	source: "genius" | "none";
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
}

/*
 * Genius supplies the text and the anchors; Spotify supplies the clock. They are
 * separate copies of the same song, matched on normalized text once per track.
 *
 * The axis is unreliable track-wide: against Bohemian Rhapsody this matched 0 of
 * 24 lines, because Genius merges a line where Spotify splits it per clause. A
 * line that does match is exact, so callers treat the timing as optional.
 *
 * The alternative, which lyrics-plus uses, is to make Spotify's lyrics the timed
 * body and layer annotations on top; that needs a different structure, since the
 * anchors index Genius' own copy.
 */
export const applyTiming = (lines: LyricLine[], timing?: Array<{ text: string; startTimeMs?: number }>) => {
	if (!timing || timing.length === 0) return lines;

	// Queued rather than deduplicated: a chorus recurs with a different offset
	// each time and the Genius lines are identical copies, so pairing is by order.
	// Taking the first match pinned the second chorus to the first one's offset.
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
}: BuildInput): TrackView => {
	const views: LineView[] = lines.map((line, index) => {
		// Every line of a span carries the same referent id, so this one lookup
		// attaches the note and marks the lines sharing it, which is what lets
		// hovering any line of a multi-line note light all of it.
		const attached = line.referentIds
			.map((id) => notes.get(id))
			.filter((note): note is Annotation => Boolean(note?.text));
		const unique = [...new Map(attached.map((note) => [note.referentId, note])).values()];

		// Annotated as soon as the page carries an anchor, so a highlight goes up
		// long before the note arrives; it stops once they are all answered and
		// none carried a body.
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

	// From the notes, not the anchors, since one id repeats across a span's lines.
	const annotationCount = notes.size;

	return {
		title,
		artist,
		lines: views,
		annotatedCount,
		annotationCount,
		source: views.length > 0 ? "genius" : "none",
	};
};

/** The states a track can be in, so the view can explain itself. */
export type ViewState = "loading" | "ready" | "no-genius" | "failed";

export interface PanelState {
	state: ViewState;
	track: TrackView | null;
	error?: string;
}

export const INITIAL_STATE: PanelState = { state: "loading", track: null };

/**
 * -1 when the track has no synced axis, or before the first line starts.
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
