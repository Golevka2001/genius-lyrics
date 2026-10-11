/*
 * The panel's state and its data chain, with the transport passed in.
 *
 * This is the half of the panel that decides what is on screen, kept apart from
 * the React tree so the ordering can be tested without a renderer. The transport
 * is injected because it is the only reason this file cannot be exercised under
 * `bun test` on its own: every decision below is about *when* a request happens
 * and *what* survives a track change.
 */

import { pickHit, type Annotation, type GeniusSong, type LyricLine, type SongHit, type SpotifyLyrics } from "./logic.ts";
import { applyTiming, buildTrackView, type PanelState } from "./view.ts";
import type { AnnotationBatch } from "./genius.ts";

export interface TrackItem {
	name?: string;
	uri?: string;
	artists?: Array<{ name?: string }>;
}

export interface Transport {
	searchSong(title: string, artist: string): Promise<SongHit[]>;
	fetchSong(id: number): Promise<GeniusSong | null>;
	fetchLyrics(songUrl: string): Promise<LyricLine[]>;
	fetchSpotifyLyrics(trackUri: string): Promise<SpotifyLyrics | null>;
	fetchAnnotations(referentIds: string[], options: { signal?: AbortSignal; onBatch?: (b: AnnotationBatch) => void }): Promise<AnnotationBatch>;
	/** Why Genius is unreachable, for the panel to explain. */
	detectFailure(error: unknown): string;
	warn(message: string, ...rest: unknown[]): void;
}

export interface Panel {
	/** The current panel state, for the tree to render. */
	readonly state: PanelState;
	/** Which line's notes are open, or null when the panel shows plain lyrics. */
	readonly openLine: number | null;
	/** Referent ids under the pointer, or null. */
	readonly hoverIds: string[] | null;
	/** Runs `listener` on every state change, and returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** Loads a track, replacing whatever was on screen. */
	load(item: TrackItem | undefined): Promise<void>;
	/** Opens the line's notes, or closes them if they are already open. */
	toggle(line: number): void;
	/** Lights the lines carrying these referent ids, or clears them on null. */
	hover(ids: string[] | null): void;
}

export function createPanel(transport: Transport): Panel {
	let state: PanelState = { state: "loading", track: null };
	let openLine: number | null = null;
	let hoverIds: string[] | null = null;
	const listeners = new Set<() => void>();

	/** Bumped per load so a slow response for a previous track is discarded. */
	let generation = 0;

	/**
	 * The pass over a track's notes, cancelled when the listener moves on.
	 *
	 * Aborting stops the batches that have not been sent yet, which is most of a
	 * long song's work: a popular one carries 50+ referents. The batch in flight is
	 * not cancelled — client.cosmos.get takes no AbortSignal — but the generation
	 * check drops its answer.
	 */
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

		inflight?.abort();
		const controller = new AbortController();
		inflight = controller;

		if (!key) {
			setState({ state: "no-genius", track: null });
			return;
		}

		setState({ state: "loading", track: null });

		const title = item?.name ?? "";
		const artist = item?.artists?.map((a) => a.name ?? "").join(", ") ?? "";

		try {
			const hits = await transport.searchSong(title, artist);
			if (mine !== generation) return;

			// Genius' order can put a same-titled song by another artist first.
			const hit = pickHit(hits, title, artist);
			if (!hit) {
				setState({ state: "no-genius", track: buildTrackView({ title, artist }) });
				return;
			}

			const [song, lines] = await Promise.all([transport.fetchSong(hit.id), transport.fetchLyrics(hit.url)]);
			if (mine !== generation) return;

			if (lines.length === 0) {
				// Genius has the song but its page yielded no readable lyrics, which is not
				// the same as the track being absent.
				setState({ state: "no-genius", track: buildTrackView({ title, artist }) });
				return;
			}

			const referentIds = [...new Set(lines.flatMap((line) => line.referentIds))];
			const annotationless = song?.annotationCount === 0;

			// Annotations and the timing axis are independent; a track without
			// Spotify lyrics still gets its notes. The axis is one request and decides
			// whether the lines can follow playback, so it is worth waiting for; the
			// notes are many and are not.
			const lyrics = await transport.fetchSpotifyLyrics(key).catch(() => null);
			if (mine !== generation) return;

			// applyTiming wants the lines on their own, not the wrapper. Only a synced
			// payload carries offsets.
			const timing = lyrics?.synced ? lyrics.lines : undefined;

			// Matched onto Genius' lines once, here: the view is rebuilt for every
			// batch of notes that lands, and this walks both sides of the match each
			// time for a result that cannot change.
			const timed = applyTiming(lines, timing);

			// The lyrics and every anchor are known at this point, which is enough to
			// read the song. Holding the panel on "loading" until all fifty notes had
			// arrived meant a popular track sat blank for the length of the whole
			// fetch, so they stream in behind the first paint instead.
			const notes = new Map<string, Annotation>();
			const settled = new Set<string>();
			const paint = () => {
				setState({
					state: "ready",
					track: buildTrackView({ title, artist, lines: timed, notes, settled, annotationless }),
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