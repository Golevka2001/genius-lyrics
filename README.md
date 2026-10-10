# genius-lyrics

Show lyrics from Genius with the annotations attached to the lines they explain.

Click an annotated line to read the note; a note that spans several lines is
tinted as one region, and the lyrics and notes are selectable so they can be
copied.

## Requirements

- spicetify CLI v3 with the **daemon running**. Genius never sends
  `Access-Control-Allow-Origin`, and spicetify's hosted proxy
  (`cors-proxy.spicetify.app`) keeps a domain allowlist that genius.com is not
  on, so requests have to go through the local proxy at
  `http://127.0.0.1:7967/proxy/{url}` — which the daemon serves. Without it,
  configure your own proxy via `Spicetify.CORSProxy.configure({ mode: "custom",
  template: "https://your-proxy/{url}" })`.
- Genius itself needs no OAuth and no proxy for reachability; only the browser
  same-origin policy is in the way.

## Commands

```bash
bun install       # install dependencies
bun run check     # tsc + module standard audit
bun test          # unit tests for the pure logic
bun run build     # bundle into dist/genius-lyrics@<version>
bun run dev       # watch, rebuild and hot-push into a running client
```

To sideload a build into a running client without going through `dev`:

```bash
bunx spicetify-kit install dist/genius-lyrics@0.1.0   # or a .zip from a release
bunx spicetify-kit pack dist/genius-lyrics@0.1.0      # zip it, prints a sha256
```

`bun run dev` and `spicetify-kit install` both need the client listening on
`--remote-debugging-port=9229`.

## Shape

This is an **app-shaped module**: it registers a `navlink` entry and owns the
`/genius-lyrics` route, so the client renders and keeps the page. That matters
because the playbar and the right sidebar re-render roughly every 300ms — any
DOM injected into them is dropped again almost immediately, which is why an
earlier extension-shaped attempt kept flickering.

## How the data is assembled

Genius exposes two different things that both look like "lyrics", and only one
of them is:

| Source | What it actually holds |
| --- | --- |
| `/api/songs/{id}` → `description.dom` | Genius' **editorial prose** about the song ("According to Thom Yorke, …") — not lyrics |
| the rendered page → `data-lyrics-container` | the **actual lyric lines**, each annotated fragment wrapped in `<a href="/<referentId>/…">` |

The chain is therefore:

1. `search/song` to find the song (query built with `URLSearchParams`; an
   earlier revision encoded the query itself and double-encoded it, matching
   nothing)
2. `songs/{id}` for metadata and the community annotation count
3. the rendered page, parsed once into `LyricLine { text, referentIds }`
4. `referents/{id}` per id, falling back to `annotations/{id}`
5. `attachAnnotations` — a lookup keyed by the page's own anchors

Step 5 is deliberately **not** text matching. A referent fragment often spans a
line break, and a song's verses are separate lyric blocks, so matching
fragments back to lines scored 0/10 against real data while reading the anchors
scores 8/8, including the `accepted` vs `unreviewed` split.

Spotify's `color-lyrics` is fetched separately and used only for the timing
axis; the lyrics shown are Genius', because the annotation anchors belong to
that copy.

Every request in the chain is cached for the session, one cache per resource:
searches by query, songs and lyric pages by id/url, referents by id, and Spotify
lyrics by track. A request still in flight is shared rather than repeated, and a
failed one is dropped so the next ask retries. Returning to a track therefore
costs no network at all.

A request that never answers is abandoned after eight seconds instead of holding
the panel on "loading" forever, so a stalled proxy surfaces as an explained
failure the user can retry rather than an endless spinner.

## Rendering ahead of the notes

Step 4 is the slow one: a popular song carries 50+ referents, and waiting for all
of them left the panel on "Loading" for the length of the whole fetch. So the
panel paints as soon as step 3 is done — the lyrics and every annotation anchor are
already known at that point — and the notes stream in behind it, each batch
repainting the lines it completed.

An anchor is what marks a line annotated, not the note behind it, so a line is
clickable and highlighted from the first paint. What is genuinely unknown until a
note lands is whether that anchor carries a body at all, so `settled` tracks which
referents have been answered: a line reads "Loading note…" while any of its
referents are outstanding, and only stops being clickable once they are all
answered and none of them held a body. The verified tint and the annotated count
fill in as the notes arrive rather than gating the first paint.

Switching tracks aborts the pass. `client.cosmos.get` takes no `AbortSignal`, so
the batch in flight is not cancelled — that is most of a long song's work anyway —
and its answer is dropped by the generation check.

## Layout

- `logic.ts` — pure parsing and placement, no client imports, runs under `bun test`
- `view.ts` — the view model (which line shows which notes), also pure
- `cache.ts` — a pure, per-resource promise cache with a request timeout; the
  transport wraps its requests in it, runs under `bun test`
- `genius.ts` — transport only, via `client.cosmos` for JSON and
  `client.corsProxy.fetch` for the HTML page (cosmos parses every body as JSON
  and cannot return an HTML document)
- `mod.tsx` — the page, registered as an app route with a navlink entry
- `test/fixtures/` — a trimmed capture of a real lyrics page, the only fixture:
  the parsing rules above are all about that markup, and the rest of the tests
  build their inputs inline
