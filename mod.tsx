/** Registers and renders the Genius Lyrics page. */

import type { ModuleRuntimeContext } from "/modules/stdlib/mod.ts";
import { NavLink, React, client, createRegistrar, warn } from "/modules/stdlib/mod.ts";
import {
	detectFailure,
	fetchAnnotations,
	fetchLyrics,
	fetchOriginalSong,
	fetchSongQanda,
	fetchSpotifyLyrics,
	searchSong,
} from "./genius.ts";
import type { Annotation, AnswerSource, NoteAnswer, NoteAuthor, NoteBlock, NoteSpan } from "./logic.ts";
import { createPanel, type TrackItem, type TrackTab } from "./panel.ts";
import { activeLineIndex, hasTimeline, type LineView } from "./view.ts";

const h = React.createElement;

const GENIUS_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 1000 1000" fill="currentColor">' +
	'<path d="M264 259h60l18 2 1 10 1 2v55c0 15 0 15-5 22l-5 5a220 220 0 0 0-43 219l1 8-5 4q-7-1-11-5l-2-2q-25-18-45-44l-2-3q-38-54-38-120v-2q0-52 25-98l1-2c9-16 29-51 49-51M510 258h54q5 2 8 6l2 3c18 22 41 60 39 89q-2 4-5 4h-17l-3 1h-6q-2 5-2 9v49a82 82 0 0 1-20 56l-2 3a78 78 0 0 1-56 24q-34 1-58-23a75 75 0 0 1-22-51q0-3 3-5l8-1q31-6 51-30 15-21 15-46v-77l3-9z"/>' +
	'<path d="M740 263c7 1 12 8 16 13l2 3c42 47 68 107 78 169l1 3q8 51-1 102l-1 3q-15 91-73 162l-1 2-24 25-1 1-25 22q-23 19-49 33l-2 1a344 344 0 0 1-323 1l-2-1a328 328 0 0 1-70-50l-3-3q-3-4-2-9l3-3q10 1 20 5a360 360 0 0 0 352-69l2-2 40-41 3-4a357 357 0 0 0 57-345l-1-4-1-3v-9q2-2 5-2"/>' +
	"</svg>";

const THUMB_UP_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" height="16" width="16" fill="currentColor">' +
	'<path d="M16.52 21.29H6V8.5l.84-.13a3.45 3.45 0 0 0 1.82-1.09 13.16 13.16 0 0 0 .82-1.85c1.06-2.69 2-4.78 3.52-5.31a2.06 2.06 0 0 1 1.74.17c2.5 1.42 1 5 .16 6.95-.11.27-.25.6-.31.77a.78.78 0 0 0 .6.36h4.1a2.29 2.29 0 0 1 2.37 2.37c0 .82-1.59 5.4-2.92 9.09a2.39 2.39 0 0 1-2.22 1.46zm-8.52-2h8.56a.48.48 0 0 0 .31-.17c1.31-3.65 2.73-7.82 2.79-8.44 0-.22-.1-.32-.37-.32h-4.1A2.61 2.61 0 0 1 12.54 8 4.29 4.29 0 0 1 13 6.46c.45-1.06 1.64-3.89.7-4.43-.52 0-1.3 1.4-2.38 4.14a10 10 0 0 1-1.13 2.38A5.28 5.28 0 0 1 8 10.11zM0 8.4h4.86v12.96H0z"/>' +
	"</svg>";

// User input pauses playback following for this long; new input restarts it.
const FOLLOW_PAUSE_MS = 5000;

const panel = createPanel({
	searchSong,
	fetchOriginalSong,
	fetchLyrics,
	fetchSpotifyLyrics,
	fetchSongQanda,
	fetchAnnotations,
	detectFailure,
	warn,
});

// Annotation text keeps links, quotes, and images as separate renderable blocks.
function Span({ span }: { span: NoteSpan }) {
	const href = "href" in span ? span.href : undefined;
	if (!href) return span.text;

	return h("a", { className: "gl-link", href, target: "_blank", rel: "noopener noreferrer" }, span.text);
}

function SpanLine({ spans }: { spans: NoteSpan[] }) {
	return h(
		"p",
		{ className: "gl-note-text" },
		spans.map((span, index) =>
			span.text === "\n"
				? h("br", { key: `${index}-br` })
				: h(Span, { key: `${index}-${span.text.slice(0, 8)}`, span }),
		),
	);
}

function NoteImage({ src, width, height }: { src: string; width?: number; height?: number }) {
	const [shown, setShown] = React.useState(false);
	const settle = () => setShown(true);
	const sized = width !== undefined && height !== undefined;

	const style =
		sized && !shown
			? {
					width: `min(${width}px, 100%, calc(var(--gl-note-image-max) * ${width} / ${height}))`,
					aspectRatio: `${width} / ${height}`,
				}
			: undefined;

	return h(
		"span",
		{
			className: ["gl-note-figure", shown ? "gl-note-figure-shown" : "", sized ? "gl-note-figure-sized" : ""]
				.filter(Boolean)
				.join(" "),
			style,
		},
		!shown && !sized ? h("span", { className: "gl-note-text", children: "Loading image…" }) : null,
		h("img", {
			className: "gl-note-image",
			src,
			alt: "",
			loading: "lazy",
			// A cached image can finish before React binds onLoad.
			ref: (node: HTMLImageElement | null) => {
				if (node?.complete) setShown(true);
			},
			onLoad: settle,
			onError: settle,
		}),
	);
}

function NoteVideo({ id }: { id: string }) {
	const [shown, setShown] = React.useState(false);
	const settle = () => setShown(true);

	return h(
		"a",
		{
			className: ["gl-note-figure", "gl-note-figure-sized", "gl-note-video", shown ? "gl-note-figure-shown" : ""]
				.filter(Boolean)
				.join(" "),
			href: `https://www.youtube.com/watch?v=${id}`,
			target: "_blank",
			rel: "noopener noreferrer",
			"aria-label": "YouTube video",
		},
		h("img", {
			className: "gl-note-image",
			src: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
			alt: "",
			loading: "lazy",
			// A cached thumbnail can finish before React binds onLoad.
			ref: (node: HTMLImageElement | null) => {
				if (node?.complete) setShown(true);
			},
			onLoad: settle,
			onError: settle,
		}),
		h("span", { className: "gl-note-video-play", "aria-hidden": "true" }),
	);
}

function NoteBody({ blocks, fallback }: { blocks: NoteBlock[]; fallback: string }) {
	if (blocks.length === 0) {
		return h("div", { className: "gl-note-text", children: fallback });
	}

	return h(
		"div",
		{ className: "gl-note-body" },
		blocks.map((block, index) => {
			const key = `${block.kind}-${index}`;
			if (block.kind === "paragraph") return h(SpanLine, { key, spans: block.spans });

			if (block.kind === "quote") {
				return h(
					"blockquote",
					{ key, className: "gl-note-quote" },
					block.lines.map((spans, lineIndex) => h(SpanLine, { key: `${key}-${lineIndex}`, spans })),
				);
			}

			if (block.kind === "youtube") return h(NoteVideo, { key, id: block.id });

			return h(NoteImage, { key, src: block.src, width: block.width, height: block.height });
		}),
	);
}

function NoteAuthors({ authors }: { authors: NoteAuthor[] }) {
	if (authors.length === 0) return null;

	return h(
		"div",
		{ className: "gl-note-authors" },
		authors.map((author, index) =>
			h(
				"div",
				{ key: `${author.name}-${index}`, className: "gl-note-author" },
				author.avatar
					? h("img", { className: "gl-note-avatar", src: author.avatar, alt: "", loading: "lazy" })
					: h("span", { className: "gl-note-avatar", "aria-hidden": "true" }),
				h("span", { className: "gl-note-author-name", children: author.name }),
			),
		),
	);
}

function NoteBadge({ status }: { status: Annotation["status"] }) {
	if (status === "accepted") return null;

	return h("span", {
		className: status === "unreviewed" ? "gl-note-badge gl-note-badge-unreviewed" : "gl-note-badge",
		children: status === "verified" ? "Verified" : "Unreviewed",
	});
}

function NoteCard({
	note,
	total,
	index,
	onShowNote,
}: {
	note: Annotation;
	total: number;
	index: number;
	onShowNote: (index: number) => void;
}) {
	const bylined = note.status === "verified";

	const meta =
		note.votes !== undefined
			? h(
					"div",
					{ className: "gl-note-meta" },
					h("span", {
						className: "gl-vote-icon",
						dangerouslySetInnerHTML: { __html: THUMB_UP_ICON },
						"aria-hidden": "true",
					}),
					h("span", { children: note.votes > 0 ? `+${note.votes}` : "0" }),
				)
			: null;

	const nav =
		total > 1
			? h(
					"div",
					{ className: "gl-note-nav" },
					h("button", {
						className: "gl-note-arrow",
						type: "button",
						onClick: () => onShowNote((index - 1 + total) % total),
						"aria-label": "Previous annotation",
						children: "‹",
					}),
					h("span", {
						className: "gl-note-counter",
						children: `${index + 1} / ${total}`,
					}),
					h("button", {
						className: "gl-note-arrow",
						type: "button",
						onClick: () => onShowNote((index + 1) % total),
						"aria-label": "Next annotation",
						children: "›",
					}),
				)
			: null;

	return h(
		"div",
		{ className: "gl-note" },
		note.status !== "accepted"
			? h(
					"div",
					{ className: "gl-note-head" },
					h(NoteBadge, { status: note.status }),
					bylined ? h(NoteAuthors, { authors: note.authors }) : null,
				)
			: null,
		h(NoteBody, { blocks: note.blocks, fallback: note.text }),
		meta || nav ? h("div", { className: "gl-note-foot" }, meta, nav) : null,
	);
}

function VoteMeta({ votes }: { votes: number | undefined }) {
	if (votes === undefined) return null;

	return h(
		"div",
		{ className: "gl-note-meta" },
		h("span", {
			className: "gl-vote-icon",
			dangerouslySetInnerHTML: { __html: THUMB_UP_ICON },
			"aria-hidden": "true",
		}),
		h("span", { children: votes > 0 ? `+${votes}` : "0" }),
	);
}

function AnswerCredit({ source }: { source: AnswerSource }) {
	const credit = (text: string, href: string | undefined, className: string) =>
		href
			? h("a", {
					className: `gl-note-author-name ${className} gl-link`,
					href,
					target: "_blank",
					rel: "noopener noreferrer",
					children: text,
				})
			: h("span", { className: `gl-note-author-name ${className}`, children: text });

	return h(
		"div",
		{ className: "gl-note-authors" },
		source.artistImage
			? h("img", { className: "gl-note-avatar", src: source.artistImage, alt: "", loading: "lazy" })
			: null,
		credit(source.artistName, source.artistUrl, ""),
		source.viaName ? credit(`via ${source.viaName}`, source.viaUrl, "gl-note-via") : null,
	);
}

function Answer({ answer }: { answer: NoteAnswer }) {
	return h(
		"div",
		{ className: "gl-qa" },
		h("div", { className: "gl-qa-q" }, h(NoteBody, { blocks: answer.question, fallback: "" })),
		h(
			"div",
			{ className: "gl-note" },
			answer.status !== "accepted" || answer.source
				? h(
						"div",
						{ className: "gl-note-head" },
						h(NoteBadge, { status: answer.status }),
						answer.source ? h(AnswerCredit, { source: answer.source }) : null,
					)
				: null,
			h(NoteBody, { blocks: answer.answer, fallback: "" }),
			answer.votes !== undefined
				? h("div", { className: "gl-note-foot" }, h(VoteMeta, { votes: answer.votes }))
				: null,
		),
	);
}

function Line({
	view,
	isOpen,
	noteIndex,
	isActive,
	openIds,
	hoverIds,
	onHover,
	onToggle,
	onShowNote,
}: {
	view: LineView;
	isOpen: boolean;
	noteIndex: number;
	isActive: boolean;
	openIds: string[] | undefined;
	hoverIds: string[] | null;
	onHover: (ids: string[] | null) => void;
	onToggle: () => void;
	onShowNote: (index: number) => void;
}) {
	const total = view.notes.length;
	const index = total > 0 ? Math.min(noteIndex, total - 1) : 0;
	const note = view.notes[index];
	const lit = (ids: string[] | undefined) =>
		Boolean(ids?.some((id) => openIds?.includes(id) || hoverIds?.includes(id)));

	return h(
		"div",
		{
			className: [
				"gl-line-wrap",
				view.annotated ? (view.noteStart === false ? " gl-note-cont" : " gl-note-start") : "",
				view.verified ? " gl-note-verified" : "",
				view.blank ? " gl-blank" : "",
			]
				.filter(Boolean)
				.join(" "),
			"data-line": view.index,
		},
		h(
			"div",
			{ className: `gl-line${isActive ? " gl-line-active" : ""}` },
			h("span", {
				className: "gl-text",
				children: view.chunks
					? view.chunks.map((chunk, index) => {
							const marked = view.annotated && chunk.referentIds !== undefined;
							const classes = marked
								? [
										"gl-anchor",
										...(chunk.carriesUp ? ["gl-anchor-up"] : []),
										...(chunk.carriesDown ? ["gl-anchor-down"] : []),
										...(lit(chunk.referentIds) ? ["gl-anchor-hover"] : []),
									]
								: [];
							return h(
								"span",
								{
									key: index,
									className: classes.join(" ") || undefined,
									role: marked ? "button" : undefined,
									tabIndex: marked ? 0 : undefined,
									title: marked ? "Show annotation" : undefined,
									onClick: marked ? onToggle : undefined,
									onMouseEnter: marked ? () => onHover(chunk.referentIds) : undefined,
									onMouseLeave: marked ? () => onHover(null) : undefined,
									onKeyDown: marked
										? (event: KeyboardEvent) => {
												if (event.key !== "Enter" && event.key !== " ") return;
												event.preventDefault();
												onToggle();
											}
										: undefined,
								},
								chunk.runs.map((run, position) => {
									const classes =
										run.italic || run.bold
											? [
													"gl-emph",
													...(run.italic ? ["gl-emph-italic"] : []),
													...(run.bold ? ["gl-emph-bold"] : []),
												]
											: [];
									return h("span", {
										key: position,
										className: classes.join(" ") || undefined,
										children: run.text,
									});
								}),
							);
						})
					: view.text,
			}),
		),
		isOpen
			? h(
					"div",
					{ className: "gl-pop" },
					note
						? h(NoteCard, { key: note.id, note, total, index, onShowNote })
						: h(
								"div",
								{ className: "gl-note" },
								h("div", {
									className: "gl-note-text",
									children: view.resolved ? "No note here." : "Loading note…",
								}),
							),
				)
			: null,
	);
}

function usePanel() {
	const [, force] = React.useReducer((count: number) => count + 1, 0);

	React.useEffect(() => panel.subscribe(force), []);

	return panel;
}

const TABS: Array<{ id: TrackTab; label: string }> = [
	{ id: "annotations", label: "Lyrics & Annotations" },
	{ id: "bio", label: "About" },
	{ id: "qa", label: "Q&A" },
];

function Tabs({ tab, onSelect }: { tab: TrackTab; onSelect: (tab: TrackTab) => void }) {
	return h(
		"div",
		{ className: "gl-tabs", role: "tablist" },
		TABS.map((entry) =>
			h(
				"button",
				{
					key: entry.id,
					className: entry.id === tab ? "gl-tab gl-tab-active" : "gl-tab",
					type: "button",
					role: "tab",
					"aria-selected": entry.id === tab,
					onClick: () => onSelect(entry.id),
				},
				entry.label,
			),
		),
	);
}

function HeadLink({ className, href, children }: { className: string; href?: string; children: string }) {
	if (!href) return h("div", { className, children });

	return h(
		"a",
		{ className: `${className} gl-head-link`, href, target: "_blank", rel: "noopener noreferrer" },
		children,
	);
}

function Panel({ pageRef }: { pageRef: React.RefObject<HTMLDivElement> }) {
	const panel = usePanel();
	const state = panel.state;
	const [position, setPosition] = React.useState<number | null>(null);
	const following = React.useRef(true);
	const pauseTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const activeLine = React.useRef(-1);
	const lastTrack = React.useRef<string | null>(null);

	const stopPauseTimer = () => {
		if (pauseTimer.current === undefined) return;
		clearTimeout(pauseTimer.current);
		pauseTimer.current = undefined;
	};

	const scrollToActive = (index: number) => {
		const scroller = pageRef.current;
		const node = scroller?.querySelector<HTMLElement>(`[data-line="${index}"]`);
		if (!scroller || !node) return;

		const page = scroller.getBoundingClientRect();
		const rect = node.getBoundingClientRect();
		const top = scroller.scrollTop + rect.top - page.top - scroller.clientHeight / 2;
		scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
	};

	// Resuming only moves the page when the active line is out of view.
	const resumeFollow = () => {
		following.current = true;
		stopPauseTimer();

		const index = activeLine.current;
		if (index < 0) return;

		const scroller = pageRef.current;
		const node = scroller?.querySelector<HTMLElement>(`[data-line="${index}"]`);
		if (!scroller || !node) return;

		const page = scroller.getBoundingClientRect();
		const rect = node.getBoundingClientRect();
		if (rect.top >= page.top && rect.bottom <= page.bottom) return;
		scrollToActive(index);
	};

	const pauseFollow = () => {
		following.current = false;
		if (pauseTimer.current !== undefined) clearTimeout(pauseTimer.current);
		pauseTimer.current = setTimeout(() => {
			pauseTimer.current = undefined;
			resumeFollow();
		}, FOLLOW_PAUSE_MS);
	};

	// Spotify timing is optional; without it the panel does not follow playback.
	const timed = state.track ? hasTimeline(state.track.lines) : false;

	React.useEffect(() => {
		if (!timed) {
			setPosition(null);
			return;
		}
		// getProgress() extrapolates from wall-clock time, which races ahead while the player state
		// is frozen. positionAsOfTimestamp is the real position, and still follows seeks.
		const tick = () => {
			const state = client.player.data;
			setPosition(state?.isBuffering ? state.positionAsOfTimestamp : (client.player.getProgress() ?? 0));
		};
		tick();
		client.player.addEventListener("onprogress", tick);
		return () => client.player.removeEventListener("onprogress", tick);
	}, [timed]);

	const activeIndex =
		panel.tab === "annotations" && state.state === "ready" && state.track && position !== null
			? activeLineIndex(state.track.lines, position)
			: -1;

	React.useEffect(() => {
		// The highlight keeps advancing; only the scroll follows this flag.
		activeLine.current = activeIndex;
		if (activeIndex < 0 || !following.current) return;
		scrollToActive(activeIndex);
	}, [activeIndex]);

	const trackKey =
		state.state === "ready" && state.track
			? (state.track.url ?? `${state.track.title}\u0000${state.track.artist}`)
			: null;

	React.useEffect(() => {
		if (trackKey === null || trackKey === lastTrack.current) return;
		lastTrack.current = trackKey;

		// A new track always resumes and catches up to its active line.
		const paused = !following.current;
		following.current = true;
		stopPauseTimer();
		if (paused && activeLine.current >= 0) scrollToActive(activeLine.current);
	}, [trackKey]);

	React.useEffect(() => {
		const root = pageRef.current?.parentElement;
		if (!root) return;

		// Scrolling, touching, clicking, or pressing a key stops following.
		const onInput = () => pauseFollow();
		root.addEventListener("wheel", onInput, { passive: true });
		root.addEventListener("touchmove", onInput, { passive: true });
		root.addEventListener("pointerdown", onInput);
		root.addEventListener("keydown", onInput);
		return () => {
			root.removeEventListener("wheel", onInput);
			root.removeEventListener("touchmove", onInput);
			root.removeEventListener("pointerdown", onInput);
			root.removeEventListener("keydown", onInput);
			stopPauseTimer();
		};
	}, [pageRef]);

	if (state.state === "loading") {
		return h("div", { className: "gl-status", children: "Loading Genius lyrics…" });
	}

	if (state.state === "failed") {
		const reason = state.error ?? "Could not reach Genius.";
		return h(
			"div",
			{ className: "gl-status gl-status-error" },
			h("p", { children: reason }),
			h("button", {
				className: "gl-retry",
				type: "button",
				onClick: () => void panel.retry(),
				children: "Retry",
			}),
		);
	}

	const track = state.track;
	if (state.state === "no-genius" || !track || track.lines.length === 0) {
		return h(
			"div",
			{ className: "gl-status" },
			h("p", { children: "No lyrics on Genius." }),
			track ? h("p", { className: "gl-hint", children: `${track.title} — ${track.artist}` }) : null,
			h("button", {
				className: "gl-retry",
				type: "button",
				onClick: () => void panel.retry(),
				children: "Retry",
			}),
		);
	}

	const lines = h(
		"div",
		{ className: "gl-lines" },
		track.lines.map((view) => {
			return h(Line, {
				key: view.index,
				view,
				isActive: view.index === activeIndex,
				isOpen: panel.openLine === view.index,
				noteIndex: panel.openNote,
				openIds: panel.openLine !== null ? track.lines[panel.openLine]?.referentIds : undefined,
				hoverIds: panel.hoverIds,
				onHover: (ids) => panel.hover(ids),
				onToggle: () => panel.toggle(view.index),
				onShowNote: (index) => panel.showNote(index),
			});
		}),
	);

	const pane =
		panel.tab === "bio"
			? track.bio.length > 0
				? h(
						"div",
						{ className: "gl-bio" },
						track.bioStatus && track.bioStatus !== "accepted"
							? h("div", { className: "gl-note-head" }, h(NoteBadge, { status: track.bioStatus }))
							: null,
						h(NoteBody, { blocks: track.bio, fallback: "" }),
						track.bioVotes !== undefined
							? h("div", { className: "gl-note-foot" }, h(VoteMeta, { votes: track.bioVotes }))
							: null,
					)
				: h("div", { className: "gl-status gl-status-pane", children: "No song bio on Genius." })
			: panel.tab === "qa"
				? track.qa.length > 0
					? h(
							"div",
							{ className: "gl-qa-list" },
							track.qa.map((answer) => h(Answer, { key: answer.id, answer })),
						)
					: h("div", { className: "gl-status gl-status-pane", children: "No Q&A on Genius." })
				: lines;

	return h(
		"div",
		{ className: "gl-panel" },
		h(
			"header",
			{ className: "gl-head" },
			h(HeadLink, { className: "gl-title", href: track.url, children: track.title }),
			h(HeadLink, { className: "gl-artist", href: track.artistUrl, children: track.artist }),
		),
		h(Tabs, {
			tab: panel.tab,
			onSelect: (next) => {
				panel.selectTab(next);
				// Returning to the lyrics cancels any pause.
				if (next === "annotations") {
					following.current = true;
					stopPauseTimer();
				}
			},
		}),
		pane,
	);
}

function ScrollMarkers({ pageRef }: { pageRef: React.RefObject<HTMLDivElement> }) {
	const panel = usePanel();
	const state = panel.state;
	const track = state.state === "ready" ? state.track : null;
	const visible = panel.tab === "annotations" && track !== null;
	const [marks, setMarks] = React.useState<Array<{ index: number; top: number }>>([]);

	React.useEffect(() => {
		const scroller = pageRef.current;
		if (!scroller || !track || !visible) {
			setMarks([]);
			return;
		}

		const measure = () => {
			const content = scroller.querySelector<HTMLElement>(".gl-lines");
			if (!content) return;

			const height = scroller.clientHeight;
			const total = scroller.scrollHeight;
			if (!height || !total) return;

			// Viewport coords of the top of the scroll content, so the measured
			// offset stays the same while a smooth scroll is in flight.
			const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
			const next: Array<{ index: number; top: number }> = [];
			for (const line of track.lines) {
				if (!line.annotated) continue;
				const node = content.querySelector<HTMLElement>(`[data-line="${line.index}"]`);
				if (!node) continue;

				const top = ((node.getBoundingClientRect().top - base) / total) * height;
				const last = next[next.length - 1];
				// Overlapping ticks would only show as one, so keep the first.
				if (last && top - last.top < 3) continue;
				next.push({ index: line.index, top });
			}
			setMarks(next);
		};

		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(scroller);
		const content = scroller.querySelector(".gl-lines");
		if (content) observer.observe(content);
		return () => observer.disconnect();
	}, [pageRef, visible, track]);

	if (!visible || marks.length === 0) return null;

	const jump = (index: number) => {
		const scroller = pageRef.current;
		const node = scroller?.querySelector<HTMLElement>(`[data-line="${index}"]`);
		if (!scroller || !node) return;

		const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
		scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 2), behavior: "smooth" });
	};

	return h(
		"div",
		{ className: "gl-markers" },
		marks.map((mark) =>
			h("button", {
				key: mark.index,
				className: "gl-marker",
				type: "button",
				style: { top: `${mark.top}px` },
				tabIndex: -1,
				"aria-label": "Go to annotation",
				onClick: () => jump(mark.index),
			}),
		),
	);
}

function App() {
	const currentTrack = () => client.player.data?.item as TrackItem | undefined;
	const pageRef = React.useRef<HTMLDivElement>(null);

	React.useEffect(() => {
		void panel.load(currentTrack());
	}, []);

	React.useEffect(() => {
		if (client.player.data?.item) return;
		const timer = setInterval(() => {
			if (!client.player.data?.item) return;
			clearInterval(timer);
			void panel.load(currentTrack());
		}, 200);
		return () => clearInterval(timer);
	}, []);

	React.useEffect(() => {
		const onChange = () => void panel.load(currentTrack());
		client.player.addEventListener("songchange", onChange);
		return () => client.player.removeEventListener("songchange", onChange);
	}, []);

	return h(
		"div",
		{ className: "gl-root" },
		h("div", { className: "gl-page", ref: pageRef }, h(Panel, { pageRef })),
		h(ScrollMarkers, { pageRef }),
	);
}

const ROUTE = "/genius-lyrics";

export default function (ctx: ModuleRuntimeContext) {
	const registrar = createRegistrar(ctx);

	registrar.register(
		"navlink",
		React.createElement(NavLink, {
			localizedApp: "Genius Lyrics",
			appRoutePath: ROUTE,
			icon: GENIUS_ICON,
			activeIcon: GENIUS_ICON,
		}),
	);
	registrar.registerRoute(ROUTE, React.createElement(App));
}
