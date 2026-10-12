/** Builds render-ready track state outside the React tree. */

import type { Annotation, LyricLine, LyricRun } from "./logic.ts";
import { normalize } from "./logic.ts";

export type LineView = {
	index: number;
	text: string;
	runs?: LyricRun[];
	notes: Annotation[];
	referentIds: string[];
	annotated: boolean;
	resolved: boolean;
	verified: boolean;
	startTimeMs?: number;
	noteStart?: boolean;
	blank?: boolean;
};

export type TrackView = {
	title: string;
	artist: string;
	lines: LineView[];
	annotatedCount: number;
	annotationCount: number;
	source: "genius" | "none";
};

export type BuildInput = {
	title: string;
	artist: string;
	lines?: LyricLine[];
	notes?: Map<string, Annotation>;
	settled?: Set<string>;
};

export type ViewState = "loading" | "ready" | "no-genius" | "failed";

export type PanelState = {
	state: ViewState;
	track: TrackView | null;
	error?: string;
};

export const INITIAL_STATE: PanelState = { state: "loading", track: null };

// Repeated lyric lines are matched in order so each chorus keeps its own timestamp.
export function applyTiming(lines: LyricLine[], timing?: Array<{ text: string; startTimeMs?: number }>) {
	if (!timing || timing.length === 0) return lines;

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
		if (!queue || queue.length === 0) return line;
		const startTimeMs = queue.shift() as number;
		return { ...line, startTimeMs };
	});
}

export function buildTrackView({ title, artist, lines = [], notes = new Map(), settled = new Set() }: BuildInput) {
	const views: LineView[] = lines.map((line, index) => {
		const attached = line.referentIds
			.map((id) => notes.get(id))
			.filter((note): note is Annotation => Boolean(note?.text));
		const unique = [...new Map(attached.map((note) => [note.referentId, note])).values()];

		// An anchored line stays clickable while its annotation is still loading.
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
	const annotationCount = notes.size;

	return {
		title,
		artist,
		lines: views,
		annotatedCount,
		annotationCount,
		source: views.length > 0 ? "genius" : "none",
	} satisfies TrackView;
}

export function activeLineIndex(lines: LineView[], progressMs: number): number {
	let active = -1;
	for (const [index, line] of lines.entries()) {
		if (line.startTimeMs !== undefined && line.startTimeMs <= progressMs) active = index;
		else if (line.startTimeMs !== undefined && line.startTimeMs > progressMs) break;
	}
	return active;
}

export function hasTimeline(lines: LineView[]): boolean {
	return lines.some((line) => line.startTimeMs !== undefined);
}
