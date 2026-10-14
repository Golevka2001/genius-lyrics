/** Registers and renders the Genius Lyrics page. */

import type { ModuleRuntimeContext } from "/modules/stdlib/mod.ts";
import { NavLink, React, client, createRegistrar, warn } from "/modules/stdlib/mod.ts";
import {
	detectFailure,
	fetchAnnotations,
	fetchLyrics,
	fetchOriginalSong,
	fetchSpotifyLyrics,
	searchSong,
} from "./genius.ts";
import type { Annotation, NoteBlock, NoteSpan } from "./logic.ts";
import { createPanel, type TrackItem } from "./panel.ts";
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

// Used to scroll the active lyric line into view.
let activeRef: { current: HTMLElement | null } | { current: null } = { current: null };

const panel = createPanel({
	searchSong,
	fetchOriginalSong,
	fetchLyrics,
	fetchSpotifyLyrics,
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

			return h("img", { key, className: "gl-note-image", src: block.src, alt: "", loading: "lazy" });
		}),
	);
}

function NoteAuthors({ note }: { note: Annotation }) {
	if (note.authors.length === 0) return null;

	return h(
		"div",
		{ className: "gl-note-authors" },
		note.authors.map((author, index) =>
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
					bylined ? h(NoteAuthors, { note }) : null,
				)
			: null,
		h(NoteBody, { blocks: note.blocks, fallback: note.text }),
		meta || nav ? h("div", { className: "gl-note-foot" }, meta, nav) : null,
	);
}

function Line({
	view,
	isOpen,
	noteIndex,
	isActive,
	hovered,
	onHover,
	onToggle,
	onShowNote,
}: {
	view: LineView;
	isOpen: boolean;
	noteIndex: number;
	isActive: boolean;
	hovered: boolean;
	onHover: (ids: string[] | null) => void;
	onToggle: () => void;
	onShowNote: (index: number) => void;
}) {
	const total = view.notes.length;
	const index = total > 0 ? Math.min(noteIndex, total - 1) : 0;
	const note = view.notes[index];

	// The clickable area stays on the lyric text so selecting the row still works.
	return h(
		"div",
		{
			className: [
				"gl-line-wrap",
				view.annotated ? (view.noteStart === false ? " gl-note-cont" : " gl-note-start") : "",
				view.verified ? " gl-note-verified" : "",
				view.blank ? " gl-blank" : "",
				hovered && view.annotated ? " gl-note-hover" : "",
			]
				.filter(Boolean)
				.join(" "),
			ref: isActive ? activeRef : undefined,
		},
		h(
			"div",
			{
				role: view.annotated ? "button" : undefined,
				tabIndex: view.annotated ? 0 : undefined,
				className: `gl-line${isActive ? " gl-line-active" : ""}`,
				onKeyDown: (event: KeyboardEvent) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					onToggle();
				},
			},
			h("span", {
				className: "gl-text",
				onClick: view.annotated ? onToggle : undefined,
				onMouseEnter: view.annotated ? () => onHover(view.referentIds) : undefined,
				onMouseLeave: view.annotated ? () => onHover(null) : undefined,
				title: view.annotated ? "Show annotation" : undefined,
				children: view.runs
					? view.runs.map((run, index) => {
							const classes = [
								"gl-emph",
								...(run.italic ? ["gl-emph-italic"] : []),
								...(run.bold ? ["gl-emph-bold"] : []),
							];
							return h("span", {
								key: index,
								className: run.italic || run.bold ? classes.join(" ") : undefined,
								children: run.text,
							});
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

function Panel() {
	const panel = usePanel();
	const state = panel.state;
	const [position, setPosition] = React.useState<number | null>(null);

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
		state.state === "ready" && state.track && position !== null ? activeLineIndex(state.track.lines, position) : -1;

	React.useEffect(() => {
		if (activeIndex < 0) return;
		const node = activeRef.current;
		if (!node) return;
		const scroller = node.closest<HTMLElement>(".gl-page");
		if (!scroller) return;
		const offset = node.offsetTop - scroller.clientHeight / 2;
		scroller.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
	}, [activeIndex]);

	if (state.state === "loading") {
		return h("div", { className: "gl-status", children: "Loading Genius lyrics…" });
	}

	if (state.state === "failed") {
		const reason = state.error ?? "Could not reach Genius.";
		return h(
			"div",
			{ className: "gl-status gl-status-error" },
			h("p", { children: reason }),
			/proxy|daemon|CORS/i.test(reason)
				? h("p", {
						className: "gl-hint",
						children:
							"Genius needs a CORS proxy, and spicetify's hosted one will not carry genius.com. Start the spicetify daemon, then retry.",
					})
				: null,
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
			h("p", { children: "No lyrics on Genius for this track." }),
			track ? h("p", { className: "gl-hint", children: `${track.title} — ${track.artist}` }) : null,
			h("button", {
				className: "gl-retry",
				type: "button",
				onClick: () => void panel.retry(),
				children: "Retry",
			}),
		);
	}

	return h(
		"div",
		{ className: "gl-panel" },
		h(
			"header",
			{ className: "gl-head" },
			h("div", { className: "gl-title", children: track.title }),
			h("div", { className: "gl-artist", children: track.artist }),
			h("div", {
				className: "gl-count",
				children: `${track.annotationCount} ${track.annotationCount === 1 ? "annotation" : "annotations"}`,
			}),
		),
		h(
			"div",
			{ className: "gl-lines" },
			track.lines.map((view) => {
				const openIds = panel.openLine !== null ? track.lines[panel.openLine]?.referentIds : undefined;
				const opened = openIds !== undefined && view.referentIds.some((id) => openIds.includes(id));

				return h(Line, {
					key: view.index,
					view,
					isActive: view.index === activeIndex,
					isOpen: panel.openLine === view.index,
					noteIndex: panel.openNote,
					hovered:
						opened ||
						(panel.hoverIds !== null && view.referentIds.some((id) => panel.hoverIds.includes(id))),
					onHover: (ids) => panel.hover(ids),
					onToggle: () => panel.toggle(view.index),
					onShowNote: (index) => panel.showNote(index),
				});
			}),
		),
	);
}

function App() {
	const currentTrack = () => client.player.data?.item as TrackItem | undefined;

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

	return h("div", { className: "gl-page" }, h(Panel, null));
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
