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

The viewer's sprite art lives as PNGs in `sprites/`; after changing any,
run `node tools/build-viewer-sprites.js`, which packs them into
`viewer/sprite_data.js` for the viewer to load in one request.

## Tests

```
npm test
```

The tests build a synthetic replay and exercise the parser on it, then
parse every `.wbv` in `samples/` in full. That directory holds one real
game, `smol_war.wbv`: a two-player strict game on Smol War, 28 minutes,
logged by a WinBolo 2.0.3 server. It is also the file to try the viewer
on. The sound rules and the Tauri app's `window.api` shim are tested on
their own, the latter against a mocked bridge.

# WinBolo Replay Viewer

`viewer/` plays replays back: gameplay, alliances, messages, sound, seeking,
speeds up to 64×, and a viewpoint selector choosing whose side draws as
friendly. It runs three ways from the same files.

**As a web page:** hosted at
[rooklift.github.io/winbolo_parser](https://rooklift.github.io/winbolo_parser)
(replays are parsed in the browser and never uploaded). Or open
`viewer/index.html` locally, or serve the `viewer/` directory with any
static file server. Drop a `.wbv` on it, or click to choose one. Toggle shortcuts on the web are bare keys (D, I, G,
M, B, N, T, E, P, L, A) rather than Ctrl+key. Since there is no menu to read
the keys off, the web version alone gets a shortcut sheet: press `?`, or
use the `?` button at the end of the transport bar.

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
| A                    | game sounds (off until switched on; muted above 1×) |
| wheel, Ctrl + - 0    | zoom at the cursor, zoom, centre the map        |
| drag                 | pan                                             |
| L                    | lock the view to the viewpoint player           |
| G, T, M, B, N        | simple graphics, simple terrain, simple LGM, big shots, neutral pill colour |
| E                    | event messages on the wire (joins, deaths, alliances, votes); off by default, chat only |
| P                    | pre-game messages on the wire (the lobby, at negative times); off by default |
| D, I                 | debug coordinates, pillbox IDs                  |
| U                    | debug base stocks: shells / mines / armour      |
| Ctrl+S               | save the map as it was at the start, as a BMAPBOLO file |

(Ctrl with the toggle keys in the apps.)

## Status

A server log begins when the server starts, usually long before the game
does. The replay begins at the game start the server marks (the clock
and the seek bar count from there); the lobby before it is not played,
but its chat is on the message wire at negative times, so the panel
opens on it, with a "game started" line at 0:00 dividing it from the
game's; P hides the lobby's lines. The map name follows the server's "Map changed
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

Sound is inferred. The format has Sound events, but no server writes
them (the sample holds none), so the viewer works the sounds out from
what the log does state, on the rules of WinBolo's own source: each
shell the tracker traces to a muzzle is a shot, and each burst it
explains is a hit on a tank, a pillbox, a building or a tree; the
terrain changes are the builders farming and building, mines laid and
going off, and a dead tank's wreckage landing (a block of craters is
the big explosion, a lone one the small); a pillbox put down or repaired
is building, a lost builder dies, a drowning sinks. The sounds are off
until switched on (the speaker button on the transport bar, A on the web,
Ctrl+A in the apps), mute above 1×, and are heard from the camera: near
when on screen, far when off it, and a camera locked to a player hears
that player's own gunfire and hits as the player would.

## Provenance and credits

- **[WinBolo](https://github.com/milki/winbolo)** (**John Morrison**,
  1998-2008, GPL v2): the log format, the map codec, the terrain tile
  rules and the tile art; and his specification of the 2.03 replay
  format, which named the version 2 events and the attribution records.
- **Stuart Cheshire**: Bolo itself, whose sprites the art descends from,
  and whose sound samples `viewer/sounds/` holds, as WinBolo's `sounds/`
  ships them (lobby and ping sounds left out), in the 16-bit conversions
  the Ancient Bolo viewer carries.
- **[Ancient Bolo Parser](https://github.com/rooklift/ancient_bolo_parser)**:
  the viewer's design, layout and controls, its sound system, and its
  `format.js` and `sprites.js`, which are ports of WinBolo's `bolo_map.c`
  and `screencalc.c`.
