# Genius Lyrics

View Genius annotated lyrics for the song currently playing in Spotify.

<!-- Screenshot placeholder: add one screenshot of the Genius Lyrics page here. -->

## Features

- Displays **lyrics and annotations from Genius** for the current track.
- Click an annotated line to read the **explanation and quotes** attached to it.
- **Synced lyrics**: Highlights the current lyric line as the song plays. *(Experimental)*

## Requirements

The Spicetify daemon must be running.
Genius does not send `Access-Control-Allow-Origin`, so requests need to go through a CORS proxy.

## Installation

Install it from the Spicetify Marketplace when available, or build it from source:

```sh
git clone https://github.com/Golevka2001/genius-lyrics.git
cd genius-lyrics
bun install
bun run build
bunx spicetify-kit install dist/genius-lyrics@0.1.0
spicetify apply
```

Use the versioned directory generated in `dist/` if the package version changes.

## Usage

1. Start the Spicetify daemon.
2. Open **Genius Lyrics** from Spotify's navigation bar.
3. Play a song. The app loads its Genius lyrics automatically.
4. Click an annotated lyric line to expand its notes.

## Planned

- [ ] `Verified`/`Reviewed`/`Unreviewed` annotation labels.
- [ ] Comments, song bio, song Q&A, and external links.
- [ ] Annotation and lyrics translations.
- [x] Live annotation count while annotations are loading.
- [ ] Annotation markers in the scrollbar.
- [x] Time anchors for annotations.
- [ ] Loading indicators for images.
- [ ] ...

## Troubleshooting

### Genius cannot be reached

Make sure the Spicetify daemon is running, then reopen Genius Lyrics or click Retry.

### No lyrics are shown

Not every song has lyrics on Genius.
Check the track and artist information, or click Retry to try again.

### Synced lyrics are missing or incomplete

Synced lyrics are *experimental*.
Some songs have no synced timeline.
And Spotify may combine multiple Genius lines into one timestamp sometimes, so some lines may be skipped.

### Annotations are still loading

Lyrics and annotations are fetched separately.
Lyrics can appear before the annotations finish loading; slow connections may leave some lines in a loading state temporarily.
