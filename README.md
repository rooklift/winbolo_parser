# WinBolo Parser

A parser for the replay files written by **WinBolo** servers (`.wbv`), and a
viewer that plays them back.

WinBolo (John Morrison, 1998-2008, GPL v2) is the Windows reimplementation
of Bolo. Its server can log a game; the log is a zip holding a tick stream
of every tank, man and shell position, every terrain change, every pill
and base change, and the chat. The format is that of the GPL source's
`log.c`, with the additions of the current, closed-source servers found by
inspection. It is written up in [FORMAT.md](docs/FORMAT.md).

Sibling of the [Ancient Bolo Parser](https://github.com/rooklift/ancient_bolo_parser),
which does the same for classic Mac Bolo logs, a far more troublesome format.
The viewer here follows that viewer's design and shares its tile art.

The parser is dependency-free JavaScript (Node ≥ 18, or any current browser).

## Usage

```
node bin/dump.js <replay>                summary
node bin/dump.js <replay> --chat         messages and comings and goings
node bin/dump.js <replay> --events       every event, one per line
node bin/dump.js <replay> --json         one JSON object per event
node bin/dump.js <replay> --snapshots    the periodic state snapshots
node bin/dump.js <replay> --attribution  the attribution.trk records
```

Library:

```js
const zip = require("./src/zip.js");
const inflate = require("./src/inflate.js");
const WinBoloLog = require("./src/parse.js");

let { log, attribution } = await WinBoloLog.open_archive(bytes, zip, inflate);
log.header;      // map name, game type, WinBolo version, creation time, ...
log.events;      // [{ tick, type, name, ...fields }] in order; 50 ticks per second
log.snapshots;   // [{ tick, pills, bases, starts, players, runs }]; WinBoloLog.snapshot_grid(s) decodes the map
log.ticks;       // length of the game in ticks
```

The same three files run unchanged in a browser as classic scripts
(`window.WinBoloZip`, `window.WinBoloInflate`, `window.WinBoloLog`);
`tools/build-viewer-parser.js` concatenates them into `viewer/logparse.js`.

## Tests

```
npm test
```

The tests build a synthetic replay and exercise the parser on it, then
parse every `.wbv` in `samples/` in full. That directory holds one real
game, `smol_war.wbv`: a two-player strict game on Smol War, 28 minutes,
logged by a WinBolo 2.0.3 server. It is also the file to try the viewer
on.

# WinBolo Replay Viewer

`viewer/` plays replays back: gameplay, alliances, messages, seeking,
speeds up to 64×, and a viewpoint selector choosing whose side draws as
friendly. It runs three ways from the same files.

**As a web page:** open `viewer/index.html` in a browser, or serve the
`viewer/` directory with any static file server. Drop a `.wbv` on it, or
click to choose one. Toggle shortcuts on the web are bare keys (D, I, G,
M, B, N, T, E, L) rather than Ctrl+key.

**As an [Electron](https://www.electronjs.org/) app:**

```
cd viewer
npx electron .
```

`viewer/builder.py` assembles distributable Electron folders from a
downloaded Electron release, by hand; releases on GitHub carry only the
Tauri build.

**As a [Tauri](https://tauri.app) app (Windows):** `viewer/tauri/` hosts
the same viewer in a small Rust program around the WebView2 engine Windows
already ships, so the app is a few MB instead of the ~200 MB Electron
folder. `npm run build` in that directory needs a Rust toolchain. On GitHub,
publishing a release builds it and attaches the zip, and the "Tauri test
build" workflow in the Actions tab builds any branch by hand.

## Controls

| key                  | action                                          |
|----------------------|-------------------------------------------------|
| Space                | play / pause                                    |
| ← → (Shift: ×6)      | back / forward 10 seconds                       |
| ↑ ↓                  | previous / next change                          |
| Home, End            | beginning, end                                  |
| F1 to F8             | speed 0.5× to 64×                               |
| wheel, Ctrl + - 0    | zoom at the cursor, zoom, centre the map        |
| drag                 | pan                                             |
| L                    | lock the view to the viewpoint player           |
| G, T, M, B, N        | simple graphics, simple terrain, simple LGM, big shots, neutral pill colour |
| E                    | event messages on the wire (joins, deaths, alliances, votes); off by default, chat only |
| D, I                 | debug coordinates, pillbox IDs                  |
| Ctrl+S               | save the map as it was at the start, as a BMAPBOLO file |

(Ctrl with the toggle keys in the apps.)

## Status

A server log begins when the server starts, usually long before the game
does. The replay begins at the game start the server marks (the clock
and the seek bar count from there); the lobby before it is not played,
but its chat is on the message wire at negative times, so the panel
opens on it. The map name follows the server's "Map changed
to" announcements, since the header names only the map the server began
with. The log records every mine, hidden or not, so the replay shows
them all.

Everything the log states is drawn; nothing is interpolated, as WinBolo
logs every moving object every tick. Shells are anonymous in the log,
but the engine follows each one from its muzzle to its burst, so it
knows who fired it and what it hit; a shell that falls at the end of its
range lands with the Mac viewer's quiet splash rather than a fireball
(FORMAT.md has the method). Every event type of the 2.03 format is
decoded, and `attribution.trk` is read into named records, though the
viewer draws nothing from it yet; an event type from a later WinBolo is
skipped by its length.

## Provenance and credits

- **[WinBolo](https://github.com/milki/winbolo)** (**John Morrison**,
  1998-2008, GPL v2): the log format, the map codec, the terrain tile
  rules and the tile art; and his specification of the 2.03 replay
  format, which named the version 2 events and the attribution records.
- **Stuart Cheshire**: Bolo itself, whose sprites the art descends from.
- **[Ancient Bolo Parser](https://github.com/rooklift/ancient_bolo_parser)**:
  the viewer's design, layout and controls, and its `format.js` and
  `sprites.js`, which are ports of WinBolo's `bolo_map.c` and `screencalc.c`.
