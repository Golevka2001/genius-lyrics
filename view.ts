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

function normalizeTimingText(value: string): string {
	return normalize(value.replace(/\([^)]*\)/g, ""));
}

function similarity(left: string, right: string): number {
	if (left === right) return 1;
	if (!left || !right) return 0;

	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row += 1) {
		let diagonal = previous[0];
		previous[0] = row;
		for (let column = 1; column <= right.length; column += 1) {
			const above = previous[column];
			previous[column] = Math.min(
				previous[column] + 1,
				previous[column - 1] + 1,
				diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
			);
			diagonal = above;
		}
	}

	return 1 - previous[right.length] / Math.max(left.length, right.length);
}

type TimingEntry = { text: string; startTimeMs?: number };

type AlignmentStep =
	| { kind: "match"; geniusStart: number; geniusCount: number; spotifyStart: number; spotifyCount: number }
	| { kind: "skip-genius" }
	| { kind: "skip-spotify" };

function joinTimingText(entries: Array<{ text: string }>): string {
	return entries.map((entry) => normalizeTimingText(entry.text)).join("");
}

function alignTiming(lines: LyricLine[], timing: TimingEntry[]): Array<{
	geniusIndexes: number[];
	spotifyIndexes: number[];
}> {
	const genius = lines
		.map((line, index) => ({ line, index, text: normalizeTimingText(line.text) }))
		.filter((entry) => entry.text);
	const spotify = timing
		.map((entry, index) => ({ entry, index, text: normalizeTimingText(entry.text) }))
		.filter((entry) => entry.text && entry.entry.startTimeMs !== undefined);
	const width = spotify.length + 1;
	const score = Array.from({ length: genius.length + 1 }, () => Array<number>(width).fill(Number.NEGATIVE_INFINITY));
	const path: Array<Array<AlignmentStep | undefined>> = Array.from({ length: genius.length + 1 }, () =>
		Array<AlignmentStep | undefined>(width).fill(undefined),
	);
	score[0][0] = 0;

	const update = (toI: number, toJ: number, value: number, step: AlignmentStep) => {
		if (value <= score[toI][toJ]) return;
		score[toI][toJ] = value;
		path[toI][toJ] = step;
	};

	for (let i = 0; i <= genius.length; i += 1) {
		for (let j = 0; j <= spotify.length; j += 1) {
			if (!Number.isFinite(score[i][j])) continue;
			if (i < genius.length) update(i + 1, j, score[i][j] - 1, { kind: "skip-genius" });
			if (j < spotify.length) update(i, j + 1, score[i][j] - 1, { kind: "skip-spotify" });

			for (let geniusCount = 1; geniusCount <= 3 && i + geniusCount <= genius.length; geniusCount += 1) {
				for (let spotifyCount = 1; spotifyCount <= 3 && j + spotifyCount <= spotify.length; spotifyCount += 1) {
					const left = joinTimingText(genius.slice(i, i + geniusCount));
					const right = joinTimingText(spotify.slice(j, j + spotifyCount));
					const matchScore = similarity(left, right);
					if (matchScore < 0.62) continue;
					const groupPenalty = (geniusCount - 1 + spotifyCount - 1) * 0.5;
					update(
						i + geniusCount,
						j + spotifyCount,
						score[i][j] + matchScore * 10 - groupPenalty,
						{ kind: "match", geniusStart: i, geniusCount, spotifyStart: j, spotifyCount },
					);
				}
			}
		}
	}

	const matches: Array<{ geniusIndexes: number[]; spotifyIndexes: number[] }> = [];
	let i = genius.length;
	let j = spotify.length;
	while (i > 0 || j > 0) {
		const step = path[i][j];
		if (!step) break;
		if (step.kind === "match") {
			matches.unshift({
				geniusIndexes: genius.slice(step.geniusStart, step.geniusStart + step.geniusCount).map((entry) => entry.index),
				spotifyIndexes: spotify
					.slice(step.spotifyStart, step.spotifyStart + step.spotifyCount)
					.map((entry) => entry.index),
			});
			i -= step.geniusCount;
			j -= step.spotifyCount;
		} else if (step.kind === "skip-genius") {
			i -= 1;
		} else {
			j -= 1;
		}
	}
	return matches;
}

export function applyTiming(lines: LyricLine[], timing?: Array<{ text: string; startTimeMs?: number }>) {
	if (!timing || timing.length === 0) return lines;

	const result = [...lines];
	for (const match of alignTiming(lines, timing)) {
		const startTimeMs = timing[match.spotifyIndexes[0]]?.startTimeMs;
		if (startTimeMs === undefined) continue;
		for (const geniusIndex of match.geniusIndexes) {
			result[geniusIndex] = { ...result[geniusIndex], startTimeMs };
		}
	}
	return result;
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
		if (
			line.startTimeMs !== undefined &&
			line.startTimeMs <= progressMs &&
			(active < 0 || line.startTimeMs > (lines[active].startTimeMs ?? -1))
		) {
			active = index;
		}
		else if (line.startTimeMs !== undefined && line.startTimeMs > progressMs) break;
	}
	return active;
}

export function hasTimeline(lines: LineView[]): boolean {
	return lines.some((line) => line.startTimeMs !== undefined);
}
