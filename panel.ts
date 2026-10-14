/** Coordinates track loading and exposes render-ready panel state. */

import {
	pickHit,
	type Annotation,
	type GeniusSong,
	type LyricLine,
	type SongHit,
	type SpotifyLyrics,
} from "./logic.ts";
import { applyTiming, buildTrackView, INITIAL_STATE, type PanelState } from "./view.ts";
import type { AnnotationBatch } from "./genius.ts";

export type TrackItem = {
	name?: string;
	uri?: string;
	artists?: Array<{ name?: string }>;
};

export type Transport = {
	searchSong(title: string, artist: string): Promise<SongHit[]>;
	fetchOriginalSong(id: number): Promise<GeniusSong | null>;
	fetchLyrics(songUrl: string): Promise<LyricLine[]>;
	fetchSpotifyLyrics(trackUri: string): Promise<SpotifyLyrics | null>;
	fetchAnnotations(
		referentIds: string[],
		options: { signal?: AbortSignal; onBatch?: (b: AnnotationBatch) => void },
	): Promise<AnnotationBatch>;
	detectFailure(error: unknown): string;
	warn(message: string, ...rest: unknown[]): void;
};

export type Panel = {
	readonly state: PanelState;
	readonly openLine: number | null;
	/** Which of the open line's notes the popover shows. Lines carry several. */
	readonly openNote: number;
	readonly hoverIds: string[] | null;
	subscribe(listener: () => void): () => void;
	load(item: TrackItem | undefined): Promise<void>;
	retry(): Promise<void>;
	toggle(line: number): void;
	showNote(index: number): void;
	hover(ids: string[] | null): void;
};

export function createPanel(transport: Transport): Panel {
	let state: PanelState = INITIAL_STATE;
	let openLine: number | null = null;
	let openNote = 0;
	let hoverIds: string[] | null = null;
	const listeners = new Set<() => void>();

	// Every load gets a generation so late results from an older track are ignored.
	let generation = 0;

	let lastItem: TrackItem | undefined;

	let inflight: AbortController | null = null;

	function notify() {
		for (const listener of listeners) listener();
	}

	function setState(next: PanelState) {
		state = next;
		notify();
	}

	async function load(item: TrackItem | undefined) {
		const key = item?.uri ?? "";
		const mine = ++generation;
		openLine = null;
		openNote = 0;
		lastItem = item;

		inflight?.abort();
		const controller = new AbortController();
		inflight = controller;

		if (!key) {
			setState({ state: "no-genius", track: null });
			return;
		}

		setState({ state: "loading", track: null });

		const title = item?.name ?? "";
		const names = (item?.artists ?? []).map((a) => a.name ?? "").filter(Boolean);
		const artist = names.join(", ");
		const lead = names[0] ?? artist;

		try {
			const hits = await transport.searchSong(title, lead);
			if (mine !== generation) return;

			const hit = pickHit(hits, title, artist);
			if (!hit) {
				setState({ state: "no-genius", track: buildTrackView({ title, artist }) });
				return;
			}

			const song = await transport.fetchOriginalSong(hit.id);
			if (mine !== generation) return;

			const lines = await transport.fetchLyrics(song?.url || hit.url);
			if (mine !== generation) return;

			if (lines.length === 0) {
				setState({ state: "no-genius", track: buildTrackView({ title, artist }) });
				return;
			}

			const geniusTitle = song?.title || hit.title || title;
			const geniusArtist = song?.artist || hit.artist || artist;
			const referentIds = [...new Set(lines.flatMap((line) => line.referentIds))];

			const lyrics = await transport.fetchSpotifyLyrics(key).catch(() => null);
			if (mine !== generation) return;

			const timing = lyrics?.synced ? lyrics.lines : undefined;

			const timed = applyTiming(lines, timing);

			const notes = new Map<string, Annotation[]>();
			const settled = new Set<string>();
			// Lyrics render first; annotation batches update the same track incrementally.
			const paint = () => {
				setState({
					state: "ready",
					track: buildTrackView({ title: geniusTitle, artist: geniusArtist, lines: timed, notes, settled }),
				});
			};

			paint();

			await transport.fetchAnnotations(referentIds, {
				signal: controller.signal,
				onBatch: (batch) => {
					if (mine !== generation) return;
					for (const [id, value] of batch.notes) notes.set(id, value);
					for (const id of batch.settled) settled.add(id);
					paint();
				},
			});
		} catch (error) {
			if (mine !== generation) return;
			transport.warn("[genius-lyrics] track failed", error);
			setState({ state: "failed", track: null, error: transport.detectFailure(error) });
		}
	}

	return {
		get state() {
			return state;
		},
		get openLine() {
			return openLine;
		},
		get openNote() {
			return openNote;
		},
		get hoverIds() {
			return hoverIds;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async load(item) {
			await load(item);
		},
		async retry() {
			await load(lastItem);
		},
		toggle(line) {
			if (openLine === line) {
				openLine = null;
			} else {
				openLine = line;
				openNote = 0;
			}
			notify();
		},
		showNote(index) {
			openNote = index;
			notify();
		},
		hover(ids) {
			hoverIds = ids;
			notify();
		},
	};
}
