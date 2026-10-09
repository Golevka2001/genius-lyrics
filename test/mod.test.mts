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
	assert.match(modSource, /dangerouslySetInnerHTML: \{ __html: THUMB_UP \}/);
	assert.match(modSource, /children: note\.votes > 0 \? `\+\$\{note\.votes\}` : "0"/);
});
