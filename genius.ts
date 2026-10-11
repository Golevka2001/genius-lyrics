/*
 * Genius sends no CORS header, so every request here goes through spicetify's
 * proxy chain. The hosted end of that chain allowlists domains genius.com is not
 * on, which is what the daemon is for; detectFailure() tells the two apart.
 */

import { client, warn } from "/modules/stdlib/mod.ts";
import { createCache } from "./cache.ts";
import { cleanTitleText, isOriginalSong, parseLyricLines, parseReferent, parseSearchResults, parseSong, parseSpotifyLyrics, throwIfGeniusRefused, type Annotation, type GeniusSong, type LyricLine, type SongHit, type SpotifyLyrics } from "./logic.ts";

const ORIGIN = "https://genius.com";

// The window lyrics-plus keeps its data for.
const RESULT_TTL = 10 * 60 * 1000; // ms
const CACHE = { ttl: RESULT_TTL };

// Genius titles rarely match Spotify's formatting, so each is tried stripped too.
export const buildQueries = (title: string, artist: string): string[] => {
	const base = cleanTitleText(title);
	const candidates = [title, base, base.replace(/\s*feat\..*$/i, "").trim()];
	const queries: string[] = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const query = `${artist} ${candidate}`.trim();
		if (query && !queries.includes(query)) queries.push(query);
	}
	return queries;
};

const searchPage = createCache(async (query: string): Promise<SongHit[]> => {
	// Wide because Genius ranks community translations alongside originals,
	// and a narrow page can come back with nothing but translations.
	const perPage = "30";
	const url = `${ORIGIN}/api/search/song?${new URLSearchParams({ per_page: perPage, q: query })}`;
	const body = (await client.cosmos.get(url)) as { response?: unknown; code?: number };

	return parseSearchResults(body);
}, CACHE);

export const searchSong = async (title: string, artist: string): Promise<SongHit[]> => {
	for (const query of buildQueries(title, artist)) {
		const hits = await searchPage.get(query);
		if (hits.length > 0) return hits;
	}
	return [];
};

const songCache = createCache(async (id: number): Promise<GeniusSong | null> => {
	const body = (await client.cosmos.get(`${ORIGIN}/api/songs/${id}`)) as { response?: unknown; code?: number };
	// A refusal carries only a status, so it would otherwise read as a song with no metadata.
	throwIfGeniusRefused(body);
	return parseSong(body);
}, CACHE);

const fetchSong = (id: number): Promise<GeniusSong | null> => songCache.get(id);

// A hit can be a translation, whose notes are about another language's wording.
// The original is the first sibling absent from its own group, which in every
// group checked was the first one asked.
export const fetchOriginalSong = async (id: number): Promise<GeniusSong | null> => {
	const song = await fetchSong(id);
	if (!song || isOriginalSong(song)) return song;

	for (const siblingId of song.translationIds) {
		const sibling = await fetchSong(siblingId);
		if (sibling && isOriginalSong(sibling)) return sibling;
	}
	// Nothing answered: the page itself still carries lyrics and anchors.
	return song;
};

// Lyrics and anchors exist only in the rendered page.
// Not client.cosmos: it parses the body as JSON and rejects an HTML page.
export const fetchLyricsPage = async (songUrl: string): Promise<string> => {
	const response = await client.corsProxy.fetch(songUrl);
	if (!response.ok) throw new Error(`Genius page failed: ${response.status} ${response.statusText}`);
	return await response.text();
};

const lyricsCache = createCache(async (songUrl: string): Promise<LyricLine[]> =>
	parseLyricLines(await fetchLyricsPage(songUrl)),
	CACHE,
);

// One request covers both, since the anchors live in the same markup. Collecting
// ids page-wide and matching them to lines by text misplaces notes wherever a
// chorus repeats.
export const fetchLyrics = (songUrl: string): Promise<LyricLine[]> => lyricsCache.get(songUrl);

const fetchAnnotationUncached = async (referentId: string): Promise<Annotation> => {
	try {
		const body = (await client.cosmos.get(`${ORIGIN}/api/referents/${referentId}`)) as {
			response?: unknown;
			code?: number;
		};
		// Genius answers 429 with no referent at all, so a coded body means
		// "not right now" rather than "no annotation".
		if (body?.code === 429) throw new Error("Genius rate limit reached (429)");
		const annotation = parseReferent(body, referentId);
		if (annotation.text) return annotation;
	} catch (error) {
		// A referent can 404 while Genius is still indexing; the annotations
		// endpoint usually resolves in that case. A rate limit must not be
		// retried into the same wall.
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
};

const annotationCache = createCache(fetchAnnotationUncached, CACHE);

export interface AnnotationBatch {
	/** The notes in this batch that carry a body. */
	notes: Map<string, Annotation>;
	/**
	 * Every id this batch answered, including the ones with no body: the caller
	 * needs this to tell "still loading" from "nothing to show", which are
	 * otherwise the same empty note map.
	 */
	settled: string[];
}

export interface AnnotationOptions {
	// Stops the pass between batches. client.cosmos.get takes no AbortSignal, so
	// the batch in flight still lands; this keeps the rest from being sent.
	signal?: AbortSignal;
	/** Called after each batch, so the panel can paint notes as they arrive. */
	onBatch?: (batch: AnnotationBatch) => void;
}

// A popular song carries 50+ referents and asking for them all at once trips the
// rate limiter. The cache sits under the batching, so an id already held or in
// flight costs no slot and overlapping loads share one request. A rate-limited
// failure is dropped from the cache, so the next ask retries it.
export const fetchAnnotations = async (
	referentIds: string[],
	{ signal, onBatch }: AnnotationOptions = {},
): Promise<AnnotationBatch> => {
	const unique = [...new Set(referentIds)];
	const notes = new Map<string, Annotation>();
	const settled: string[] = [];

	const BATCH_SIZE = 4;
	for (let i = 0; i < unique.length; i += BATCH_SIZE) {
		// The listener moved on; the rest would be requests nobody reads.
		if (signal?.aborted) break;

		const batch = unique.slice(i, i + BATCH_SIZE);
		const results = await Promise.allSettled(batch.map((id) => annotationCache.get(id)));
		const settledHere: AnnotationBatch = { notes: new Map(), settled: [] };

		results.forEach((result, index) => {
			const id = batch[index];
			settled.push(id);
			settledHere.settled.push(id);
			if (result.status === "fulfilled") {
				// A bodyless annotation is still cached as answered, so it is not
				// asked for again, but it never enters the map.
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
};

const spotifyLyricsCache = createCache(async (trackId: string): Promise<SpotifyLyrics | null> => {
	const body = (await client.cosmos.get(
		`https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false&market=from_token`,
	)) as { lyrics?: unknown; code?: number };

	if (!body || typeof body !== "object" || body.code) return null;
	return parseSpotifyLyrics(body);
}, CACHE);

// Used purely for the timing axis. Null when the track has none — many tracks,
// especially non-English ones, 404 here — which is not a broken transport.
export const fetchSpotifyLyrics = (trackUri: string): Promise<SpotifyLyrics | null> => {
	const id = trackUri.split(":").pop();
	if (!id) return Promise.resolve(null);
	return spotifyLyricsCache.get(id);
};

// "Invalid target" is the hosted proxy answering for a host missing from its
// allowlist, which genius.com is: it means no daemon, not a misconfiguration.
export const detectFailure = (error: unknown): string => {
	const text = String((error as { message?: string })?.message ?? error);
	if (/rate limit|429/i.test(text)) {
		return "Genius is rate-limiting this client (429). Wait a moment and re-run.";
	}
	if (/Invalid target/i.test(text)) {
		return "The spicetify daemon is not running, and spicetify's hosted proxy will not carry genius.com. Start the daemon, or point the CORS proxy at your own service.";
	}
	// The daemon forwards, but Cloudflare refuses it from the exit IP.
	if (/403|Forbidden|refused/i.test(text)) {
		return "Genius refused the request (403, anti-bot protection). The proxy's exit address is being blocked by Cloudflare; point the CORS proxy at a service that requests genius.com with browser-like headers.";
	}
	if (/Failed to fetch|NetworkError|load failed/i.test(text)) {
		return "Could not reach Genius. This needs a CORS proxy: run the spicetify daemon, or configure your own.";
	}
	return text;
};
