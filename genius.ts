/*
 * Transport for Genius' web-internal JSON API.
 *
 * No OAuth: api.genius.com needs a client secret and a Bearer token, whereas
 * genius.com/api/* is what the website itself calls and needs neither. The
 * catch is that Genius never sends Access-Control-Allow-Origin, so these
 * requests have to go through a CORS proxy. client.cosmos does that for us:
 * spicetify's wrapper routes any non-Spotify host through its proxy chain
 * (local daemon first, then the hosted proxy), so no proxy is named here.
 *
 * The hosted proxy keeps a domain allowlist that genius.com is not on, so this
 * works on a machine running the spicetify daemon and otherwise needs a custom
 * proxy via Spicetify.CORSProxy.configure(). detectFailure() reports which.
 *
 * Verified reachable on 2026-10-05: search/song, songs/{id}, referents/{id},
 * annotations/{id}, and the rendered lyrics page.
 */

import { client, warn } from "/modules/stdlib/mod.ts";
import { createCache } from "./cache.ts";
import { parseReferent, parseSearchResults, parseSong, type Annotation, type GeniusSong, type LyricLine, type SongHit, type SpotifyLyrics } from "./logic.ts";
import { parseLyricLines } from "./logic.ts";

const ORIGIN = "https://genius.com";

/**
 * How long a fetched result is reused, and how long it is kept at all.
 *
 * Ten minutes is the window lyrics-plus keeps its data for: a song heard again
 * inside it costs nothing, and one heard after it is fetched fresh. Sizing by
 * time rather than by entry count is what stops the caches growing for as long
 * as the client stays open.
 */
const RESULT_TTL = 10 * 60 * 1000; // ms
const CACHE = { ttl: RESULT_TTL };

/** Song titles carry decorations that only hurt search. */
const cleanTitle = (title: string) =>
	title
		.replace(/\s*[-–—]\s*(remaster|remastered|version|edit|mix|live|mono|stereo).*$/i, "")
		.replace(/\s*\(.*?\)\s*$/g, "")
		.replace(/\s*\[.*?\]\s*$/g, "")
		.trim();

/**
 * Build search queries from a title/artist pair.
 *
 * Ordering matters: the full title is tried first, then progressively stripped
 * variants, because Genius titles rarely match Spotify's formatting exactly.
 */
export const buildQueries = (title: string, artist: string): string[] => {
	const base = cleanTitle(title);
	const candidates = [title, base, base.replace(/\s*feat\..*$/i, "").trim()];
	const queries: string[] = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const query = `${artist} ${candidate}`.trim();
		if (query && !queries.includes(query)) queries.push(query);
	}
	return queries;
};

/** One search page, keyed by the query string it was asked for. */
const searchPage = createCache(async (query: string): Promise<SongHit[]> => {
	// A wide page on purpose: Genius ranks community translations above the
	// original for many tracks — "Genius Rihanna" returns 20 translations and no
	// original at all, at any page size — so the original has to be present in
	// the window for the ranking in parseSearchResults to find it.
	const perPage = "30";
	const url = `${ORIGIN}/api/search/song?${new URLSearchParams({ per_page: perPage, q: query })}`;
	const body = (await client.cosmos.get(url)) as { response?: unknown; code?: number };

	// A 429 arrives with no sections at all, which would otherwise read as
	// "this track is not on Genius" and silently fall through the queries.
	if (body?.code === 429) throw new Error("Genius rate limit reached (429). Try again in a moment.");

	return parseSearchResults(body);
}, CACHE);

/**
 * Find the Genius song for a track.
 *
 * URLSearchParams does the encoding: an earlier lyrics-plus revision encoded
 * the query itself and ended up double-encoded, which silently matched nothing.
 *
 * Pages are cached per query, so the loop below asks each stripped variant at
 * most once per session. An empty answer is remembered too, since Genius
 * returning nothing for a query is a stable fact for the session.
 */
export const searchSong = async (title: string, artist: string): Promise<SongHit[]> => {
	for (const query of buildQueries(title, artist)) {
		const hits = await searchPage.get(query);
		if (hits.length > 0) return hits;
	}
	return [];
};

/** A song's metadata is immutable, so one fetch per id serves the session. */
const songCache = createCache(async (id: number): Promise<GeniusSong | null> => {
	const body = (await client.cosmos.get(`${ORIGIN}/api/songs/${id}`)) as { response?: unknown };
	return parseSong(body);
}, CACHE);

/** Fetch song metadata: title, url and the community annotation count. */
export const fetchSong = (id: number): Promise<GeniusSong | null> => songCache.get(id);

/**
 * Fetch the rendered lyrics page, which is the only place the lyrics and their
 * annotation anchors exist.
 *
 * This deliberately avoids client.cosmos: cosmos parses the body as JSON and
 * its fallback to blob/text cannot rescue an HTML page, so it rejects with a
 * JSON parse error. corsProxy.fetch hands back the raw Response, and it walks
 * the same proxy chain (local daemon first), so CORS is still handled for us.
 */
export const fetchLyricsPage = async (songUrl: string): Promise<string> => {
	const response = await client.corsProxy.fetch(songUrl);
	if (!response.ok) throw new Error(`Genius page failed: ${response.status} ${response.statusText}`);
	return await response.text();
};

const lyricsCache = createCache(async (songUrl: string): Promise<LyricLine[]> =>
	parseLyricLines(await fetchLyricsPage(songUrl)),
	CACHE,
);

/**
 * Fetch the lyrics together with the annotation anchors on each line.
 *
 * One request covers both, because the anchors live in the same markup: the
 * alternative (collect ids page-wide, then guess which line each belongs to by
 * matching text) misplaces notes whenever a chorus repeats or the song has
 * several verses.
 *
 * The parsed lines are cached by page url, so the fetch and the parse behind
 * this are paid once per song even when the listener comes back to it.
 */
export const fetchLyrics = (songUrl: string): Promise<LyricLine[]> => lyricsCache.get(songUrl);

/**
 * Fetch one annotation, preferring the artist's own words.
 */
const fetchAnnotationUncached = async (referentId: string): Promise<Annotation> => {
	try {
		const body = (await client.cosmos.get(`${ORIGIN}/api/referents/${referentId}`)) as {
			response?: unknown;
			code?: number;
		};
		// Genius rate-limits by responding 429 with no sections/referent, so a
		// coded body means "not available right now", not "no annotation".
		if (body?.code === 429) throw new Error("Genius rate limit reached (429)");
		const annotation = parseReferent(body, referentId);
		if (annotation.text) return annotation;
	} catch (error) {
		// A referent can 404 while Genius is still indexing; the plain
		// annotation endpoint usually still resolves in that case. A rate limit
		// must not be retried into the same wall, so rethrow it.
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

/** Referents are immutable per song, so one lookup per id is enough. */
const annotationCache = createCache(fetchAnnotationUncached, CACHE);

/** What one batch of the referents resolved. */
export interface AnnotationBatch {
	/** The notes in this batch that carry a body. */
	notes: Map<string, Annotation>;
	/**
	 * Every id this batch answered, including the ones that turned out to have no
	 * body. The caller needs this to tell "still loading" from "nothing to show",
	 * which are otherwise the same empty note map.
	 */
	settled: string[];
}

export interface AnnotationOptions {
	/**
	 * Stops the pass between batches. client.cosmos.get takes no AbortSignal, so
	 * the batch in flight still lands — this keeps the rest of them from being
	 * sent at all, which is most of the work on a 50-referent song.
	 */
	signal?: AbortSignal;
	/** Called after each batch, so the panel can paint notes as they arrive. */
	onBatch?: (batch: AnnotationBatch) => void;
}

/**
 * Resolve every annotation referenced by the lyrics, keyed by referent id.
 *
 * Fetched in small batches: a popular song carries 50+ referents at roughly a
 * second each, and requesting them all at once trips Genius' rate limiter.
 *
 * The cache sits under the batching, so an id already held or still in flight
 * resolves without spending a slot, and two loads that overlap share one
 * request per id. A rate-limited failure is dropped from the cache, so the next
 * ask retries it.
 */
export const fetchAnnotations = async (
	referentIds: string[],
	{ signal, onBatch }: AnnotationOptions = {},
): Promise<AnnotationBatch> => {
	const unique = [...new Set(referentIds)];
	const notes = new Map<string, Annotation>();
	const settled: string[] = [];

	const BATCH_SIZE = 4;
	for (let i = 0; i < unique.length; i += BATCH_SIZE) {
		// The listener moved on, so the batches after this one are requests
		// nobody would read.
		if (signal?.aborted) break;

		const batch = unique.slice(i, i + BATCH_SIZE);
		const results = await Promise.allSettled(batch.map((id) => annotationCache.get(id)));
		const settledHere: AnnotationBatch = { notes: new Map(), settled: [] };

		results.forEach((result, index) => {
			const id = batch[index];
			settled.push(id);
			settledHere.settled.push(id);
			if (result.status === "fulfilled") {
				// An annotation with no body is remembered as "nothing to show" so
				// it is not asked for again, but it never enters the map.
				if (result.value.text) {
					notes.set(id, result.value);
					settledHere.notes.set(id, result.value);
				}
				return;
			}
			// Losing one note is survivable; losing the batch to a rate limit is
			// worth surfacing.
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
	const { parseSpotifyLyrics } = await import("./logic.js");
	return parseSpotifyLyrics(body);
}, CACHE);

/**
 * Spotify's own lyrics, used purely for the timing axis.
 *
 * Returns null when the track simply has none — many tracks, especially
 * non-English ones, 404 here — which is not an error the caller should treat
 * as a broken transport.
 */
export const fetchSpotifyLyrics = (trackUri: string): Promise<SpotifyLyrics | null> => {
	const id = trackUri.split(":").pop();
	if (!id) return Promise.resolve(null);
	return spotifyLyricsCache.get(id);
};

/**
 * Report why Genius is unreachable, so the UI can explain a failure instead of
 * showing nothing.
 *
 * The "Invalid target" wording is worth spelling out: the hosted proxy answers
 * that way only for a host missing from its allowlist, and genius.com is one of
 * them, so it is what a client with no daemon to fall back on gets. It is a
 * missing daemon rather than a misconfiguration, and saying so is the difference
 * between the user starting something and the user going to look at their proxy
 * settings.
 */
export const detectFailure = (error: unknown): string => {
	const text = String((error as { message?: string })?.message ?? error);
	if (/rate limit|429/i.test(text)) {
		return "Genius is rate-limiting this client (429). Wait a moment and re-run.";
	}
	if (/Invalid target/i.test(text)) {
		return "The spicetify daemon is not running, and spicetify's hosted proxy will not carry genius.com. Start the daemon, or point the CORS proxy at your own service.";
	}
	if (/403|Forbidden/i.test(text)) return "Genius refused the request (anti-bot). Point the CORS proxy at your own service.";
	if (/Failed to fetch|NetworkError|load failed/i.test(text)) {
		return "Could not reach Genius. This needs a CORS proxy: run the spicetify daemon, or configure your own.";
	}
	return text;
};
