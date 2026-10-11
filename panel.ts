/*
 * The half of the panel that decides what is on screen, kept apart from the
 * React tree so the ordering can be tested without a renderer.
 */

import { pickHit, type Annotation, type GeniusSong, type LyricLine, type SongHit, type SpotifyLyrics } from "./logic.ts";
import { applyTiming, buildTrackView, INITIAL_STATE, type PanelState } from "./view.ts";
import type { AnnotationBatch } from "./genius.ts";

export interface TrackItem {
	name?: string;
	uri?: string;
	artists?: Array<{ name?: string }>;
}

export interface Transport {
	searchSong(title: string, artist: string): Promise<SongHit[]>;
	/** Song metadata for the original of the track's translation group. */
	fetchOriginalSong(id: number): Promise<GeniusSong | null>;
	fetchLyrics(songUrl: string): Promise<LyricLine[]>;
	fetchSpotifyLyrics(trackUri: string): Promise<SpotifyLyrics | null>;
	fetchAnnotations(referentIds: string[], options: { signal?: AbortSignal; onBatch?: (b: AnnotationBatch) => void }): Promise<AnnotationBatch>;
	/** Why Genius is unreachable, for the panel to explain. */
	detectFailure(error: unknown): string;
	warn(message: string, ...rest: unknown[]): void;
}

export interface Panel {
	readonly state: PanelState;
	/** Which line's notes are open, or null when the panel shows plain lyrics. */
	readonly openLine: number | null;
	/** Referent ids under the pointer, or null. */
	readonly hoverIds: string[] | null;
	/** Runs `listener` on every state change, and returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** Loads a track, replacing whatever was on screen. */
	load(item: TrackItem | undefined): Promise<void>;
	/** Loads the same track again, for when the last attempt failed. */
	retry(): Promise<void>;
	/** Opens the line's notes, or closes them if they are already open. */
	toggle(line: number): void;
	/** Lights the lines carrying these referent ids, or clears them on null. */
	hover(ids: string[] | null): void;
}

export function createPanel(transport: Transport): Panel {
	let state: PanelState = INITIAL_STATE;
	let openLine: number | null = null;
	let hoverIds: string[] | null = null;
	const listeners = new Set<() => void>();

	// Bumped per load so a slow response for a previous track is discarded.
	let generation = 0;

	/** The track on screen, kept so retry() can ask for it again. */
	let lastItem: TrackItem | undefined;

	// Aborting stops the batches not yet sent. The one in flight still lands —
	// client.cosmos.get takes no AbortSignal — but the generation check drops it.
	let inflight: AbortController | null = null;

	const notify = () => {
		for (const listener of listeners) listener();
	};

	const setState = (next: PanelState) => {
		state = next;
		notify();
	};

	async function load(item: TrackItem | undefined) {
		const key = item?.uri ?? "";
		const mine = ++generation;
		openLine = null;
		// A failure is usually a cold proxy or a dropped connection, and a second
		// try usually clears it.
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
		// Genius matches on the lead artist alone: "Luis Fonsi, Daddy Yankee
		// Despacito" returns translations and neither original.
		const lead = names[0] ?? artist;

		try {
			const hits = await transport.searchSong(title, lead);
			if (mine !== generation) return;

			// Scored against every name, not the one the query was made with.
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
				// Genius has the song but its page yielded nothing readable, which is
				// not the same as the track being absent.
				setState({ state: "no-genius", track: buildTrackView({ title, artist }) });
				return;
			}

			const referentIds = [...new Set(lines.flatMap((line) => line.referentIds))];

			// Worth waiting for: one request, and it decides whether the lines can
			// follow playback. The notes are many and are not waited on.
			const lyrics = await transport.fetchSpotifyLyrics(key).catch(() => null);
			if (mine !== generation) return;

			// Only a synced payload carries offsets.
			const timing = lyrics?.synced ? lyrics.lines : undefined;

			// Matched once per track: the view is rebuilt for every batch of notes
			// that lands, and this walks both sides each time for a fixed result.
			const timed = applyTiming(lines, timing);

			// The lyrics and every anchor are known, which is enough to read the song.
			// Waiting on all the notes first left a popular track blank for the
			// length of the fetch, so they stream in behind this first paint.
			const notes = new Map<string, Annotation>();
			const settled = new Set<string>();
			const paint = () => {
				setState({
					state: "ready",
					track: buildTrackView({ title, artist, lines: timed, notes, settled }),
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
			openLine = openLine === line ? null : line;
			notify();
		},
		hover(ids) {
			hoverIds = ids;
			notify();
		},
	};
}