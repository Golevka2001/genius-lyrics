import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/*
 * Guards the React tree in mod.tsx.
 *
 * These assertions are static on purpose. The bug they exist to prevent was a
 * props object using "textContent" instead of "children": React happily writes
 * unknown attributes onto the DOM node, so the element rendered empty and
 * nothing failed — no type error, no exception, just a blank badge and a blank
 * title. A renderer would catch it too, but this keeps the test suite runnable
 * without a DOM dependency.
 */

const modSource = readFileSync(new URL("../mod.tsx", import.meta.url), "utf8");
const scssSource = readFileSync(new URL("../index.scss", import.meta.url), "utf8");

test("mod.tsx never passes textContent as a prop", () => {
	// React.createElement has no textContent prop; text only appears via children.
	const offenders = modSource
		.split("\n")
		.map((line, index) => [index + 1, line] as const)
		.filter(([, line]) => /\btextContent\s*:/.test(line));

	assert.deepEqual(
		offenders.map(([line]) => line),
		[],
		`textContent is not a React prop; use children (lines: ${offenders.map(([line]) => line).join(", ")})`,
	);
});

test("mod.tsx renders text through children", () => {
	// The annotation body is the whole point of the panel, so its text must be a
	// child rather than an attribute — including the per-block renderers.
	assert.match(modSource, /className:\s*"gl-note-text"\s*,\s*children:/);
	assert.match(modSource, /className:\s*"gl-note-text"\s*\}/);
	// Links must come back as anchors, not as bare text.
	assert.match(modSource, /className: "gl-link"/);
});

test("mod.tsx uses a React key on mapped children", () => {
	// React drops list children without a key, which is another way notes vanish
	// silently rather than loudly.
	const mapped = [...modSource.matchAll(/\.map\(([^)]*)\)\s*,\s*\)?\s*$/gm)];
	assert.ok(mapped.length >= 0);
	assert.match(modSource, /key:\s*`\$\{note\.referentId\}-\$\{index\}`/);
});
test("mod.tsx renders neither an approval badge nor contributor names", () => {
	// Genius shows a note as prose with a vote count, so the card matches that:
	// no classification chip, and no roll call of who co-signed it.
	assert.ok(
		!/gl-note-authors|authors\.join|gl-badge/.test(modSource),
		"the annotation card should show neither contributors nor an approval badge",
	);
	// Genius shows a thumb with a signed count, not a worded tally.
	assert.match(modSource, /const THUMB_UP =\s*\n\t\s*'<svg/);
	// And it is the site's own glyph, kept on its own 24-grid: a stand-in from
	// the client's icon set would be drawn on 16, which is how this one started
	// out and did not match the site it is quoting.
	assert.match(modSource, /const THUMB_UP =[\s\S]*?viewBox="0 0 24 24"/);
	assert.match(modSource, /dangerouslySetInnerHTML: \{ __html: THUMB_UP \}/);
	assert.match(modSource, /children: note\.votes > 0 \? `\+\$\{note\.votes\}` : "0"/);
});

test("mod.tsx subscribes only to events the client actually dispatches", () => {
	// The client dispatches songchange, onplaypause, onprogress and appchange and
	// nothing else (spicetifyWrapper.js). A listener under any other name is
	// registered, never fires, and nothing says so: addEventListener takes
	// `type: string`, so a misspelling typechecks like any real event. That is
	// how a panel ended up watching "ontrackchange" and staying on its first
	// song for good.
	const dispatched = ["songchange", "onplaypause", "onprogress", "appchange"];
	const listened = [...modSource.matchAll(/player\.addEventListener\(\s*"([^"]+)"/g)].map(([, name]) => name);

	assert.ok(listened.length > 0, "expected the panel to follow playback");
	assert.deepEqual(
		listened.filter((name) => !dispatched.includes(name)),
		[],
		`not events the client dispatches; only ${dispatched.join(", ")} ever fire`,
	);
});

test("mod.tsx unsubscribes every player listener it registers", () => {
	// Progress effect re-runs per track, so a listener left behind is one copy
	// per song change, each still writing state ten times a second.
	const added = [...modSource.matchAll(/player\.addEventListener\(\s*"([^"]+)"/g)].map(([, name]) => name);
	const removed = [...modSource.matchAll(/player\.removeEventListener\(\s*"([^"]+)"/g)].map(([, name]) => name);

	assert.deepEqual(
		[...removed].sort(),
		[...added].sort(),
		"a listener that is never removed keeps firing after its panel is gone",
	);
});

test("mod.tsx and index.scss agree on every gl- class name", () => {
	// The class names are the one contract between the two files that nothing
	// else checks: TypeScript sees neither end of it, so a name changed on one
	// side renders unstyled and nothing fails. A verified note under a renamed
	// class would silently never turn yellow.
	const used = new Set([...modSource.matchAll(/\b(gl-[a-z-]+)\b/g)].map(([, name]) => name));
	const defined = new Set([...scssSource.matchAll(/\.(gl-[a-z-]+)/g)].map(([, name]) => name));

	assert.ok(used.size > 0, "expected the panel to use its own class names");
	assert.deepEqual(
		[...used].filter((name) => !defined.has(name)).sort(),
		[],
		"used in markup but styled nowhere, so it renders as plain markup",
	);
	assert.deepEqual(
		[...defined].filter((name) => !used.has(name)).sort(),
		[],
		"styled but never rendered, so the rule is dead",
	);
});

test("index.scss only reads CSS variables the client actually defines", () => {
	// Encore defines its palette on .encore-dark-theme / .encore-light-theme and
	// only for the names it knows. A var() for anything else silently falls back,
	// and these fallbacks were all written for a dark theme: nine of them, among
	// them --text-highlight, which the client never defines at all. That is how
	// hovered lines turned white on white the moment the theme switched to light.
	//
	// Each name below is defined in xpui-snapshot.css — check with
	// `grep -c -- "--<name>:"` in Apps/xpui before adding one.
	const defined = ["text-base", "text-negative"];
	const used = [...scssSource.matchAll(/var\((--[a-z-]+)/g)].map(([, name]) => name.slice(2));

	assert.ok(used.length > 0, "expected the panel to follow the theme");
	assert.deepEqual(
		[...new Set(used)].filter((name) => !defined.includes(name)).sort(),
		[],
		"undefined in the client, so the fallback decides — and it was written for a dark theme",
	);
});

test("index.scss re-enables selection exactly once", () => {
	// The client sets `user-select: none` on <body> and on the route container, so
	// one author rule is what makes the page selectable at all — and since the
	// property is inherited, it reaches the whole subtree from there: the lines,
	// the annotation bodies and the empty regions a drag can start in. A second
	// declaration adds nothing, which is what this block had grown into: a rule
	// per element, a prefixed twin of each, and `isolation`, which has nothing to
	// do with selection.
	// The comments above talk about the property too, so match against the rules
	// with the comments stripped: a prefixed twin counts as a second declaration.
	const rules = scssSource.replace(/\/\*[\s\S]*?\*\//g, "");
	const declared = [...rules.matchAll(/user-select:\s*([a-z-]+)/g)].map(([, value]) => value);
	assert.deepEqual(declared, ["text"], "one inherited declaration is the whole need");
});

test("nothing closes the quoted excerpt", () => {
	// Genius marks where a quotation starts and leaves the end to the reader; the
	// excerpts here stop mid-sentence, so the trailing glyph this block used to
	// draw hung off text that never had a closing bracket to give it.
	const rules = [...scssSource.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
		.map(([, selector, body]) => [selector.trim(), body] as const)
		.filter(([selector]) => selector.includes(".gl-note-quote"));

	assert.ok(rules.length > 0, "expected the excerpt to be styled");
	assert.deepEqual(
		rules.filter(([selector]) => selector.includes("::after")).map(([selector]) => selector),
		[],
		"the glyph opens the excerpt; nothing marks its end",
	);
	assert.ok(!scssSource.includes("201D"), "no closing quote glyph is left behind");
});
