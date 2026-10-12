/** Fetches and caches Genius data and Spotify timing data for the panel. */

import { client, warn } from "/modules/stdlib/mod.ts";
import { createCache } from "./cache.ts";
import {
	cleanTitleText,
	isOriginalSong,
	parseLyricLines,
	parseReferent,
	parseSearchResults,
	parseSong,
	parseSpotifyLyrics,
	throwIfGeniusRefused,
	type Annotation,
	type GeniusSong,
	type LyricLine,
	type SongHit,
	type SpotifyLyrics,
} from "./logic.ts";

const ORIGIN = "https://genius.com";

const RESULT_TTL = 10 * 60 * 1000; // ms
const CACHE = { ttl: RESULT_TTL };

// Try title variants because Spotify and Genius format titles differently.
export function buildQueries(title: string, artist: string): string[] {
	const base = cleanTitleText(title);
	const candidates = [title, base, base.replace(/\s*feat\..*$/i, "").trim()];
	const queries: string[] = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const query = `${artist} ${candidate}`.trim();
		if (query && !queries.includes(query)) queries.push(query);
	}
	return queries;
}

const searchPage = createCache(async (query: string): Promise<SongHit[]> => {
	const perPage = "30";
	const url = `${ORIGIN}/api/search/song?${new URLSearchParams({ per_page: perPage, q: query })}`;
	const body = (await client.cosmos.get(url)) as { response?: unknown; code?: number };

	return parseSearchResults(body);
}, CACHE);

export async function searchSong(title: string, artist: string): Promise<SongHit[]> {
	for (const query of buildQueries(title, artist)) {
		const hits = await searchPage.get(query);
		if (hits.length > 0) return hits;
	}
	return [];
}

const songCache = createCache(async (id: number): Promise<GeniusSong | null> => {
	const body = (await client.cosmos.get(`${ORIGIN}/api/songs/${id}`)) as { response?: unknown; code?: number };
	throwIfGeniusRefused(body);
	return parseSong(body);
}, CACHE);

function fetchSong(id: number): Promise<GeniusSong | null> {
	return songCache.get(id);
}

export async function fetchOriginalSong(id: number): Promise<GeniusSong | null> {
	const song = await fetchSong(id);
	if (!song || isOriginalSong(song)) return song;

	for (const siblingId of song.translationIds) {
		const sibling = await fetchSong(siblingId);
		if (sibling && isOriginalSong(sibling)) return sibling;
	}
	return song;
}

export async function fetchLyricsPage(songUrl: string): Promise<string> {
	const response = await client.corsProxy.fetch(songUrl);
	if (!response.ok) throw new Error(`Genius page failed: ${response.status} ${response.statusText}`);
	return await response.text();
}

const lyricsCache = createCache(
	async (songUrl: string): Promise<LyricLine[]> => parseLyricLines(await fetchLyricsPage(songUrl)),
	CACHE,
);

export function fetchLyrics(songUrl: string): Promise<LyricLine[]> {
	return lyricsCache.get(songUrl);
}

async function fetchAnnotationUncached(referentId: string): Promise<Annotation> {
	try {
		const body = (await client.cosmos.get(`${ORIGIN}/api/referents/${referentId}`)) as {
			response?: unknown;
			code?: number;
		};
		if (body?.code === 429) throw new Error("Genius rate limit reached (429)");
		const annotation = parseReferent(body, referentId);
		if (annotation.text) return annotation;
	} catch (error) {
		if (error instanceof Error && /rate limit/i.test(error.message)) throw error;
	}

	try {
		const body = (await client.cosmos.get(`${ORIGIN}/api/annotations/${referentId}`)) as {
			response?: unknown;
			code?: number;
		};
		if (body?.code === 429) throw new Error("Genius rate limit reached (429)");
		return parseReferent(body, referentId);
	} catch (error) {
		if (error instanceof Error && /rate limit/i.test(error.message)) throw error;
		warn("[genius-lyrics] annotation failed", referentId, error);
		return parseReferent(null, referentId);
	}
}

const annotationCache = createCache(fetchAnnotationUncached, CACHE);

// Requests are batched to avoid hitting Genius's rate limit.
export type AnnotationBatch = {
	notes: Map<string, Annotation>;
	settled: string[];
};

export type AnnotationOptions = {
	signal?: AbortSignal;
	onBatch?: (batch: AnnotationBatch) => void;
};

export async function fetchAnnotations(
	referentIds: string[],
	{ signal, onBatch }: AnnotationOptions = {},
): Promise<AnnotationBatch> {
	const unique = [...new Set(referentIds)];
	const notes = new Map<string, Annotation>();
	const settled: string[] = [];

	const BATCH_SIZE = 4;
	for (let i = 0; i < unique.length; i += BATCH_SIZE) {
		if (signal?.aborted) break;

		const batch = unique.slice(i, i + BATCH_SIZE);
		const results = await Promise.allSettled(batch.map((id) => annotationCache.get(id)));
		const settledHere: AnnotationBatch = { notes: new Map(), settled: [] };

		results.forEach((result, index) => {
			const id = batch[index];
			settled.push(id);
			settledHere.settled.push(id);
			if (result.status === "fulfilled") {
				if (result.value.text) {
					notes.set(id, result.value);
					settledHere.notes.set(id, result.value);
				}
				return;
			}
			warn("[genius-lyrics] annotation batch failed", id, String(result.reason));
		});

		onBatch?.(settledHere);
	}

	return { notes, settled };
}

const spotifyLyricsCache = createCache(async (trackId: string): Promise<SpotifyLyrics | null> => {
	const body = (await client.cosmos.get(
		`https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false&market=from_token`,
	)) as { lyrics?: unknown; code?: number };

	if (!body || typeof body !== "object" || body.code) return null;
	return parseSpotifyLyrics(body);
}, CACHE);

export function fetchSpotifyLyrics(trackUri: string): Promise<SpotifyLyrics | null> {
	const id = trackUri.split(":").pop();
	if (!id) return Promise.resolve(null);
	return spotifyLyricsCache.get(id);
}

export function detectFailure(error: unknown): string {
	const text = String((error as { message?: string })?.message ?? error);
	if (/rate limit|429/i.test(text)) {
		return "Genius is rate-limiting this client (429). Wait a moment and re-run.";
	}
	if (/Invalid target/i.test(text)) {
		return "The spicetify daemon is not running, and spicetify's hosted proxy will not carry genius.com. Start the daemon, or point the CORS proxy at your own service.";
	}
	if (/403|Forbidden|refused/i.test(text)) {
		return "Genius refused the request (403, anti-bot protection). The proxy's exit address is being blocked by Cloudflare; point the CORS proxy at a service that requests genius.com with browser-like headers.";
	}
	if (/Failed to fetch|NetworkError|load failed/i.test(text)) {
		return "Could not reach Genius. This needs a CORS proxy: run the spicetify daemon, or configure your own.";
	}
	return text;
}
