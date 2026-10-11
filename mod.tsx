/*
 * Sidebar lyrics panel with annotation popovers.
 *
 * Shaped after lyrics-plus: the lines are listed, and a line carrying notes is
 * clickable so its annotation opens next to it. The difference is where the
 * lines come from — Genius, because Spotify's own lyrics carry no anchors to
 * attach notes to.
 */

import type { ModuleRuntimeContext } from "/modules/stdlib/mod.ts";
import { NavLink, Platform, PlaybarButton, React, client, createRegistrar, warn } from "/modules/stdlib/mod.ts";
import { detectFailure, fetchAnnotations, fetchLyrics, fetchSong, fetchSpotifyLyrics, searchSong } from "./genius.ts";
import type { Annotation, NoteBlock, NoteSpan } from "./logic.ts";
import { createPanel, type TrackItem } from "./panel.ts";
import { activeLineIndex, hasTimeline, type LineView } from "./view.ts";

const h = React.createElement;

/**
 * Genius' own vote icon, inline SVG source.
 *
 * The glyph genius.com draws next to a note's vote count, kept as the site draws
 * it rather than as a lookalike: it is a 24-grid drawing of its own, so the
 * viewBox travels with it instead of being the client's. Markup rather than a
 * <path> because the wrapper is set through innerHTML.
 */
const THUMB_UP =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" height="16" width="16" fill="currentColor">' +
	'<path d="M16.52 21.29H6V8.5l.84-.13a3.45 3.45 0 0 0 1.82-1.09 13.16 13.16 0 0 0 .82-1.85c1.06-2.69 2-4.78 3.52-5.31a2.06 2.06 0 0 1 1.74.17c2.5 1.42 1 5 .16 6.95-.11.27-.25.6-.31.77a.78.78 0 0 0 .6.36h4.1a2.29 2.29 0 0 1 2.37 2.37c0 .82-1.59 5.4-2.92 9.09a2.39 2.39 0 0 1-2.22 1.46zm-8.52-2h8.56a.48.48 0 0 0 .31-.17c1.31-3.65 2.73-7.82 2.79-8.44 0-.22-.1-.32-.37-.32h-4.1A2.61 2.61 0 0 1 12.54 8 4.29 4.29 0 0 1 13 6.46c.45-1.06 1.64-3.89.7-4.43-.52 0-1.3 1.4-2.38 4.14a10 10 0 0 1-1.13 2.38A5.28 5.28 0 0 1 8 10.11zM0 8.4h4.86v12.96H0z"/>' +
	"</svg>";

/** Panel width, clamped to the viewport when the surface is shown. */
const PANEL_WIDTH = 380;

/** Node of the highlighted line, kept so it can be scrolled into view. */
let activeRef: { current: HTMLElement | null } | { current: null } = { current: null };

const panel = createPanel({
	searchSong,
	fetchSong,
	fetchLyrics,
	fetchSpotifyLyrics,
	fetchAnnotations,
	detectFailure,
	warn,
});

/**
 * Render one run of text, turning links back into links.
 *
 * Genius underlines artists, albums, songs and outbound references inside its
 * prose, and those links carry meaning — "confirmed" pointing at a clip is the
 * evidence for the sentence it sits in. Rendering them as plain text loses the
 * citation, so they come back as anchors with the same destination.
 */
const Span = ({ span }: { span: NoteSpan }) => {
	const href = "href" in span ? span.href : undefined;
	if (!href) return span.text;

	// No distinction between Genius' own pages and everything else: the module
	// is not on genius.com, so every link is simply somewhere else to go.
	return h("a", { className: "gl-link", href, target: "_blank", rel: "noopener noreferrer" }, span.text);
};

const SpanLine = ({ spans }: { spans: NoteSpan[] }) =>
	h(
		"p",
		{ className: "gl-note-text" },
		spans.map((span, index) =>
			span.text === "\n"
				? h("br", { key: `${index}-br` })
				: h(Span, { key: `${index}-${span.text.slice(0, 8)}`, span }),
		),
	);

/**
 * Render an annotation's blocks.
 *
 * Blocks mirror Genius' own structure: paragraphs, quoted lyric excerpts and
 * embedded images. `fallback` covers a note that arrived as flat text with no
 * DOM behind it.
 */
const NoteBody = ({ blocks, fallback }: { blocks: NoteBlock[]; fallback: string }) => {
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
};

const NoteCard = ({ note }: { note: Annotation }) =>
	h(
		"div",
		{ className: "gl-note" },
		// Genius shows neither an approval badge nor contributor names on a note,
		// so neither is rendered here; the vote count is the only meta it shows.
		h(NoteBody, { blocks: note.blocks, fallback: note.text }),
		note.votes !== undefined
			? h(
					"div",
					{ className: "gl-note-meta" },
					h(
						"span",
						{
							className: "gl-vote-icon",
							// Genius' own thumb, the same glyph the site puts
							// beside a note's vote count.
							dangerouslySetInnerHTML: { __html: THUMB_UP },
							"aria-hidden": "true",
						},
					),
					h("span", { children: note.votes > 0 ? `+${note.votes}` : "0" }),
				)
			: null,
	);

const Line = ({
	view,
	isOpen,
	isActive,
	hovered,
	onHover,
	onToggle,
}: {
	view: LineView;
	isOpen: boolean;
	isActive: boolean;
	/** True when the pointer is over any line of this note's span. */
	hovered: boolean;
	onHover: (ids: string[] | null) => void;
	onToggle: () => void;
}) =>
	h(
		"div",
		{
			className: [
				"gl-line-wrap",
				// A note that spans several lines is shown the way Genius shows it: the
				// annotated words carry a tint, and hovering any line of the span
				// brightens the whole run so it reads as one marked region.
				view.annotated ? (view.noteStart === false ? " gl-note-cont" : " gl-note-start") : "",
				// Genius colours a note the artist wrote itself yellow rather than
				// grey; every other note looks alike.
				view.verified ? " gl-note-verified" : "",
				view.blank ? " gl-blank" : "",
				// Driven from the panel rather than from CSS: the pointer is always
				// inside the line list, so a `:has()` test on the list would light
				// every annotated line, and a sibling combinator only reaches the line
				// below. The module knows which lines share a span, so it marks them.
				hovered && view.annotated ? " gl-note-hover" : "",
			]
				.filter(Boolean)
				.join(" "),
			ref: isActive ? activeRef : undefined,
		},
		// The row is a keyboard affordance and nothing else: the role and the tab
		// stop are here so a note can be opened without a pointer, and Enter/Space
		// is handled below for the same reason. Nothing about selection hangs on the
		// element choice — a <button> here would inherit the page's `user-select:
		// text` just the same.
		//
		// The pointer handlers sit on the text rather than the row: Genius marks the
		// words, and a hit area spanning the full width would light up when the
		// cursor is nowhere near the lyric.
		h(
			"div",
			{
				role: view.annotated ? "button" : undefined,
				tabIndex: view.annotated ? 0 : undefined,
				className: `gl-line${isOpen ? " gl-line-open" : ""}${isActive ? " gl-line-active" : ""}`,
				onKeyDown: (event: KeyboardEvent) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					onToggle();
				},
			},
			h("span", {
				className: "gl-text",
				onClick: view.annotated ? onToggle : undefined,
				// The line's own anchors, not the notes that have landed: the region
				// a note spans is known from the page, so hovering it highlights
				// while the note behind it is still being fetched.
				onMouseEnter: view.annotated ? () => onHover(view.referentIds) : undefined,
				onMouseLeave: view.annotated ? () => onHover(null) : undefined,
				title: view.annotated ? "Show annotation" : undefined,
				children: view.text,
			}),
		),
		isOpen
			? h(
					"div",
					{ className: "gl-pop" },
					// A line can be clickable before its note exists, so an empty
					// card here would read as "this line has nothing to say" rather
					// than "it has not arrived yet".
					!view.resolved
						? h("div", { className: "gl-note" }, h("div", { className: "gl-note-text", children: "Loading note…" }))
						: view.notes.length > 0
							? view.notes.map((note, index) => h(NoteCard, { key: `${note.referentId}-${index}`, note }))
							: h("div", { className: "gl-note" }, h("div", { className: "gl-note-text", children: "No note here." })),
				)
			: null,
	);

/**
 * The panel's current state, re-rendering this component when it changes.
 *
 * The panel owns the state and the tree only reads it, so a notification has to
 * come back through React: the panel is driven by song changes and by batches of
 * notes arriving, neither of which is a render of this tree.
 */
const usePanel = () => {
	const [, force] = React.useReducer((count: number) => count + 1, 0);

	React.useEffect(() => panel.subscribe(force), []);

	return panel;
};

const Panel = () => {
	const panel = usePanel();
	const state = panel.state;
	const [position, setPosition] = React.useState<number | null>(null);

	// Follow playback only when Spotify supplied an axis; without one there is
	// nothing to compare the clock against and every line would flicker in turn.
	const timed = state.track ? hasTimeline(state.track.lines) : false;

	React.useEffect(() => {
		if (!timed) {
			setPosition(null);
			return;
		}
		const tick = () => setPosition(client.player.getProgress() ?? 0);
		tick();
		client.player.addEventListener("onprogress", tick);
		// Unsubscribed on cleanup rather than left behind: the effect re-runs for
		// every track, so this listener would otherwise accumulate one copy per
		// song change.
		return () => client.player.removeEventListener("onprogress", tick);
	}, [timed, state.track]);

	const activeIndex =
		state.state === "ready" && state.track && position !== null
			? activeLineIndex(state.track.lines, position)
			: -1;

	// Keep the current line in view, but only when it actually moved off screen
	// — scrolling on every tick would fight the user.
	React.useEffect(() => {
		if (activeIndex < 0) return;
		const node = activeRef.current;
		if (!node) return;
		const scroller = node.closest<HTMLElement>(".gl-page");
		if (!scroller) return;
		const offset = node.offsetTop - scroller.clientHeight / 2;
		if (Math.abs(scroller.scrollTop - offset) < scroller.clientHeight / 3) return;
		scroller.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
	}, [activeIndex]);

	if (state.state === "loading") {
		return h("div", { className: "gl-status", children: "Loading Genius lyrics…" });
	}

	if (state.state === "failed") {
		return h(
			"div",
			{ className: "gl-status gl-status-error" },
			h("p", { children: state.error ?? "Could not reach Genius." }),
			// What to do about it. Genius sends no CORS headers, so every request
			// goes through a proxy, and the one that ships with spicetify only
			// carries hosts on its allowlist — which genius.com is not on. The
			// local daemon has no such list, so that is what has to be running.
			h("p", {
				className: "gl-hint",
				children: "Genius needs a CORS proxy, and spicetify's hosted one will not carry genius.com. Start the spicetify daemon and reopen this panel.",
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
				children: `${track.annotatedCount} annotated ${track.annotatedCount === 1 ? "line" : "lines"}`,
			}),
		),
		track.annotationless
			? h("p", { className: "gl-empty", children: "Genius has this song but no annotations for it." })
			: null,
		h(
			"div",
			{ className: "gl-lines" },
			track.lines.map((view) =>
				h(Line, {
					key: view.index,
					view,
					isActive: view.index === activeIndex,
					isOpen: panel.openLine === view.index,
					hovered:
						panel.hoverIds !== null && view.referentIds.some((id) => panel.hoverIds.includes(id)),
					onHover: (ids) => panel.hover(ids),
					onToggle: () => panel.toggle(view.index),
				}),
			),
		),
	);
};

/**
 * The page body.
 *
 * Data loads here rather than at module load so opening the page is what
 * triggers a fetch — by then the player is populated and the user has actually
 * asked for this track.
 */
const App = () => {
	const currentTrack = () => client.player.data?.item as TrackItem | undefined;

	React.useEffect(() => {
		void panel.load(currentTrack());
	}, []);

	// The player may not be ready on first render; re-check once it has an item.
	React.useEffect(() => {
		if (client.player.data?.item) return;
		const timer = setInterval(() => {
			if (!client.player.data?.item) return;
			clearInterval(timer);
			void panel.load(currentTrack());
		}, 200);
		return () => clearInterval(timer);
	}, []);

	// Follow the track while the page stays open.
	React.useEffect(() => {
		const onChange = () => {
			void panel.load(currentTrack());
		};
		client.player.addEventListener("songchange", onChange);
		return () => client.player.removeEventListener("songchange", onChange);
	}, []);

	return h("div", { className: "gl-page" }, h(Panel, null));
};

const ROUTE = "/genius-lyrics";

/**
 * Entry icon: the Genius mark.
 *
 * Genius' own artwork, on its 1000-unit grid. stdlib's createIconComponent takes
 * only the inner markup and supplies `viewBox="0 0 16 16"`, which is why the
 * paths are wrapped in a transform rather than rewritten as 16-grid coordinates:
 * scaling the 617 characters of path data by hand would add decimals throughout
 * and change artwork Genius drew. The transform also crops the wide empty
 * margin the source file carries, so the face fills the icon box.
 *
 * No colours are set, matching the other app modules: the client tints nav icons
 * itself and decides the active and inactive states. Both the nav link and the
 * playbar button read this one constant, so replacing it rebrands the module.
 */
const ICON =
	'<g fill="currentColor" transform="translate(-3.84 -4.66) scale(0.023)"><path d="M264 259h60l18 2 1 10 1 2v55c0 15 0 15-5 22l-5 5a220 220 0 0 0-43 219l1 8-5 4q-7-1-11-5l-2-2q-25-18-45-44l-2-3q-38-54-38-120v-2q0-52 25-98l1-2c9-16 29-51 49-51M510 258h54q5 2 8 6l2 3c18 22 41 60 39 89q-2 4-5 4h-17l-3 1h-6q-2 5-2 9v49a82 82 0 0 1-20 56l-2 3a78 78 0 0 1-56 24q-34 1-58-23a75 75 0 0 1-22-51q0-3 3-5l8-1q31-6 51-30 15-21 15-46v-77l3-9z"/><path d="M740 263c7 1 12 8 16 13l2 3c42 47 68 107 78 169l1 3q8 51-1 102l-1 3q-15 91-73 162l-1 2-24 25-1 1-25 22q-23 19-49 33l-2 1a344 344 0 0 1-323 1l-2-1a328 328 0 0 1-70-50l-3-3q-3-4-2-9l3-3q10 1 20 5a360 360 0 0 0 352-69l2-2 40-41 3-4a357 357 0 0 0 57-345l-1-4-1-3v-9q2-2 5-2"/></g>';

export default function (ctx: ModuleRuntimeContext) {
	const registrar = createRegistrar(ctx);

	// An app-shaped module owns a whole page: the client renders the route into
	// its main view and keeps it mounted, so nothing here has to survive the
	// playbar's or the right sidebar's frequent re-renders. That is the whole
	// reason to take this shape instead of injecting into a client container.
	registrar.register(
		"navlink",
		React.createElement(NavLink, { localizedApp: "Genius Lyrics", appRoutePath: ROUTE, icon: ICON, activeIcon: ICON }),
	);
	registrar.registerRoute(ROUTE, React.createElement(App));

	// The playbar button only navigates, which keeps a visible entry point even
	// when the nav link is scrolled out of sight.
	registrar.register(
		"playbarButton",
		React.createElement(PlaybarButton, {
			label: "Genius lyrics",
			icon: ICON,
			onClick: () => {
				const history = Platform.getHistory();
				if (history.location.pathname !== ROUTE) history.push(ROUTE);
				else history.goBack();
			},
		}),
	);
}
