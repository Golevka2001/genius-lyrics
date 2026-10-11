# genius-lyrics

Show Genius' lyrics with the annotations attached to the lines they explain.

Click an annotated line to read the note. A note spanning several lines is tinted as
one region, and both the lyrics and the notes are selectable.

## Requirements

**The spicetify daemon has to be running.** Genius never sends
`Access-Control-Allow-Origin`, so every request goes through a CORS proxy.
`client.corsProxy` walks a chain — the local daemon first, then spicetify's hosted
proxy — but **the hosted one keeps a domain allowlist that genius.com is not on**:

```console
$ curl -s https://cors-proxy.spicetify.app/https://genius.com/api/search/song?per_page=1&q=radiohead
{"error":"Invalid target"}
```

so the fallback is dead for this module and the daemon is the only hop that carries
Genius. The daemon has no allowlist of its own, and `Invalid target` is what the
panel reports when it is missing.

To use another service instead:

```js
Spicetify.CORSProxy.configure({ mode: "custom", template: "https://your-proxy/{url}" });
```

The module never writes this configuration itself — it belongs to the user.

## How the data is assembled

Two Genius endpoints both look like lyrics, and only one is:

| Source | What it holds |
| --- | --- |
| `/api/songs/{id}` → `description.dom` | editorial prose about the song, not lyrics |
| the rendered page → `data-lyrics-container` | the lyric lines, each annotated fragment wrapped in `<a href="/<referentId>/…">` |

Spotify's `color-lyrics` is fetched separately and used only for the timing axis;
the lyrics shown are Genius', because the anchors belong to that copy.

An anchor is what marks a line annotated, not the note behind it, so lines are
clickable from the first paint. What is unknown until a note lands is whether that
anchor carries a body at all, so a line reads "Loading note…" while its referents
are outstanding and only stops being clickable once they are all answered.

Switching tracks aborts the pass. `client.cosmos.get` takes no `AbortSignal`, so the
batch in flight still lands and its answer is dropped by a generation check.

Entries are cached per resource and expire after ten minutes, the window
`lyrics-plus` keeps its data for. Expiring by time rather than entry count is what
keeps the caches from growing for as long as the client stays open.

## Development

```bash
bun install       # install dependencies
bun run check     # tsc + module standard audit
bun test          # unit tests for the pure logic
bun run build     # bundle into dist/genius-lyrics@<version>
bun run dev       # watch, rebuild and hot-push into a running client
```

To sideload a build without going through `dev`:

```bash
bunx spicetify-kit install dist/genius-lyrics@0.1.0   # or a .zip from a release
bunx spicetify-kit pack dist/genius-lyrics@0.1.0      # zip it, prints a sha256
```

Both need the client listening on `--remote-debugging-port=9229`.

`test/fixtures/` holds a trimmed capture of a real lyrics page — the only fixture,
since the parsing rules are all about that markup. Every other test builds its
inputs inline.