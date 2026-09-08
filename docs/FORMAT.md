# WinBolo replay format

A WinBolo replay (`.wbv`) is a zip archive, written by the server with
minizip, whose archive comment is `WinBolo Log File`. It holds:

| member            | what                                                     |
|-------------------|----------------------------------------------------------|
| `log.dat`         | the game log: header, state snapshots and a tick stream  |
| `attribution.trk` | newer servers only; a record of who did what, where      |

The layout of `log.dat` is that of `log.c` in the WinBolo source (John
Morrison, 1998-2008, GPL v2, e.g. the [milki/winbolo](https://github.com/milki/winbolo)
mirror), with the changes of **log version 2** worked out by inspection of
a replay written by WinBolo 2.0.3, whose source is not public. Where this
document says "public source" it means the last GPL release, which writes
log version 0.

All multi-byte integers are big-endian unless stated. Strings are Pascal
strings: a length byte, then that many single-byte (cp1252) characters.

## Header

```
"WBOLOMOV"           8 bytes, no terminator
version              1 byte; 2 in current replays (the public source writes 0)
map name             Pascal string; the map loaded when the log began
game type            1 byte: 1 open, 2 tournament, 3 strict
hidden mines         1 byte, boolean
AI                   1 byte (allow computer tanks: 0 no, 1 yes, 2 yes with advantage)
password             1 byte, boolean
max players          1 byte
WinBolo version      3 bytes, major.minor.revision
server address       4 bytes IPv4, then 2 bytes port (both zero in the sample)
game creation time   4 bytes, unix seconds by the server's clock; when the server
                     started, not this game: it survives a return to the lobby
WinBolo.net key      32 ASCII hex characters
```

The first snapshot follows immediately.

## The tick stream

One log tick is one server tick of 20 ms (`SERVER_TICK_LENGTH` in the
public source), so 50 ticks make a second. Measured: two chat messages
typed a stopwatch minute apart sit 2973 ticks apart in the log. The stream is a sequence of
records, each starting with a type byte:

| type | record                | payload                                              |
|------|-----------------------|------------------------------------------------------|
| 0    | quit                  | one more byte, also 0; the log ends here             |
| 1    | no events             | 1 byte: that many ticks passed with nothing to log   |
| 2    | no events, long       | 2 bytes: as above, 256 or more ticks                 |
| 3    | events                | 1 byte: the number of events in this tick, then them |
| 4    | events, long          | 2 bytes: as above, 256 or more events                |
| 5    | snapshot              | the full game state, below; takes no tick            |

An events record is one tick. A no-events record is that many ticks. A
snapshot is written between ticks and describes the state after the events
before it: the server flushes the pending tick before writing one. The
server writes a snapshot at the start and then periodically (every 600
ticks in the public source, every 125 in the sample), skipping the write
when nothing has happened since the last one.

### Version 2 changes to the stream

- **No obfuscation.** The public source XORs every byte of the stream with
  a rolling key (the previous event's type number, seeded from the
  creation time). Version 2 writes plain bytes.
- **Events are length-prefixed.** Each event is a type byte, a 2-byte
  payload length, then the payload. The public source had no length, so
  a reader had to know every type's size; now unknown types can be
  skipped, and the parser does so, keeping their payload raw.
- **New event types** appear. Three are the lobby's ready and start
  sequence, read from their timing across five replays; the rest are
  unknown. See below.

## Events

Type numbers are the public `logitem` enum's. Payload fields are the
arguments `logAddEvent` was given, in order; "nibble(a, b)" is one byte
with a in the high nibble and b in the low.

| type | name              | payload                                                       |
|------|-------------------|---------------------------------------------------------------|
| 1    | PlayerJoined      | slot, 4 bytes, name. The 4 bytes were the player's IPv4 address; version 2 puts a two-letter country code in the first two and zeros in the rest |
| 2    | PlayerQuit        | slot                                                          |
| 3    | PlayerLocation    | slot, mx, my, nibble(px, py), nibble(direction 0-15, on boat). mx = my = 0 is a tank not in the world (dead, or in the lobby). Only logged when something changed |
| 4    | LgmLocation       | nibble(slot, frame), mx, my, nibble(px, py). Logged every tick the man is out of the tank; frames 0-2 walk, 3 is the parachute |
| 5    | MapChange         | x, y, terrain (file terrain codes, below)                     |
| 6    | Shell             | mx, my, nibble(px, py), frame. Logged every tick for every shell and explosion: frame 9-24 is a shell flying in direction frame - 9; frame 8 down to 1 is an explosion animating; the stages step down every third tick on a clock shared by all explosions, so the first stage a burst is logged at may be 8 or 7. The client draws stage s with its EXPLOSION(9 - s) tile: stage 8 is a tiny spark, the fireball is largest at stage 5, and stages 4 to 1 are a thinning scatter of sparks. Tank-hit debris and landing tank wreckage are logged at stage 8 every tick as they fly, so they appear as moving sparks |
| 7-17 | Sound*            | x, y of the sound: build, farm, shoot, hit tank, hit tree, hit wall, mine lay, mine explode, explosion, big explosion, man die. None occur in the sample |
| 18   | MessageServer     | text                                                          |
| 19   | MessageAll        | slot, text                                                    |
| 20   | MessagePlayers    | slot, recipient, text. Logged once per recipient, the sender included, a few ticks apart |
| 21   | ChangeName        | slot, name                                                    |
| 22   | AllyRequest       | slot, other slot                                              |
| 23   | AllyAccept        | slot, other slot                                              |
| 24   | AllyLeave         | slot                                                          |
| 25   | BaseSetOwner      | base, owner (0xff neutral), migrate flag                      |
| 26   | BaseSetStock      | base, shells, mines, armour                                   |
| 27   | PillSetOwner      | pill, owner (0xff neutral), migrate flag                      |
| 28   | PillSetHealth     | nibble(pill, armour)                                          |
| 29   | PillSetPlace      | pill, x, y                                                    |
| 30   | PillSetInTank     | nibble(pill, in tank)                                         |
| 31   | SaveMap           | slot (never written by the public source)                     |
| 32   | LostMan           | slot                                                          |
| 33   | KillPlayer        | killed slot, killer slot                                      |
| 34   | PlayerRejoin      | slot                                                          |
| 35   | PlayerLeaving     | slot                                                          |
| 36   | PlayerDied        | slot                                                          |

Shells carry no identity: the server writes its whole list of shells and
explosions every tick, in list order. They can still be followed, because
the server's view is exact and restated every tick: a shell moves 32
world units (an eighth of a tile) along its heading per tick; its first
logged position is most of a tile out from the centre of the tank or
pillbox that fired it, along its heading; and when it dies its flight
positions stop and a fresh burst (stage 8 or 7, the stages then stepping
down every third tick) appears. Where the burst
appears says what happened, because `shellsCalcCollision` snaps a hit on
a square's contents (a pillbox, alive or dead; a building or tree; the
shore, for a shell fired from a boat) to that square's centre: such a
burst's corner pixel is the square's origin, and the square's pillbox, if
it has one, is what was hit. A burst anywhere else is at the shell's own
position: a tank hit if a tank (other than the shooter's) is within a
tile, else the shell falling at the end of its range, which bursts on
its last logged position one tick later. The viewer's engine links these
into tracks, giving each shell an owner and each burst a cause. Bursts
with no track leading in are mine explosions and landing tank wreckage,
which use the same frames. Both explosion sites in `shells.c` write the
same frames, so nothing in the burst itself says.

A shell's life is fixed when it is fired, and shows in its age at a fall:
a tank shell lives 4 × gunsight − 5 logged ticks, the gunsight being 2 to
14 half-tiles (so 3 ticks at the shortest setting, 51 at the longest, in
steps of 4, landing half a tile further each notch), and a pillbox shell
63 (8.5 tiles at an eighth of a tile per tick, less the same 5). The 5
are the ticks between firing and the first logged position, during which
the shell already travels most of a tile. Measured from a replay of
fourteen shots stepping through every setting.

A death by a shell is logged as KillPlayer (killed, killer) together
with PlayerDied, the killer being NEUTRAL (255) for a pillbox, and the
dead tank's position is logged as 0,0 at the end of that tick. A tank
in deep water is logged as killed by itself (killer equal to killed),
again with PlayerDied, whether it drove in or its boat was shot from
under it; in the latter case the shell's burst on the tank and the
tank's on-boat flag dropping come a tick or two before. A boat left at the shore is a terrain
change from river to boat, and back to river when a tank takes it. A death
by a mine logs no event at all: the tank's position simply goes to 0,0
(the wreckage bursts and the crater they leave are logged, and the tank
respawns a few seconds later). Mines are logged as terrain changes to
the mined codes whether or not the game hides them, so a replay shows
every mine. An
alliance accepted by a member of an existing group joins the newcomer to
the whole group: every member's ally list then names all the others.

Pill and base numbers are 0-based. Positions are the object's centre:
square mx plus px sixteenths, so a tank parked on a square's middle has
px = py = 8. The exception is an explosion frame of a Shell event, whose
position is the top-left corner of the 16-pixel explosion tile: a shell's
burst is logged at the shell's position less half a tile (`TANK_SUBTRACT`
in `shells.c`), and the client draws every explosion frame with its corner
at the logged point, so the visible centre is half a tile down and right
of it. Directions are 16-way, 0 north, clockwise. The public source
writes KillPlayer or PlayerDied for a death; version 2 writes both in the
same tick.

### Version 2 events

| type | name        | payload | what                                                  |
|------|-------------|---------|-------------------------------------------------------|
| 39   | PlayerReady | slot    | a player's ready toggle in the lobby; repeats as they toggle |
| 42   | Countdown   | none    | the countdown begins; always exactly 250 ticks (5 s) before the start |
| 38   | GameStart   | none    | the game begins. The next snapshot (one tick later) is the first with a map and players in use; the first tank position follows a tick after that. Before this every snapshot is an empty map with no slots in use |

These three are inferred from five replays, in all of which the sequence
and the 250-tick gap are the same. The remaining new types are unknown:

| type | payload   | when                                                   |
|------|-----------|--------------------------------------------------------|
| 37   | none      | tick 0 of every log                                    |
| 41   | 2 bytes   | in the lobby, in one replay (3.1 then 2.2): team or colour changes? |
| 50   | slot, 4 bytes, name | shaped like PlayerJoined, during a game, for a player who never appeared; a join that failed? (A player joining mid-game is an ordinary PlayerJoined.) |
| 51   | slot, 4 bytes, name | as 50, in the lobby                          |

The end of a game is a vote, in three more version 2 events:

| type | name        | payload                    | what                                          |
|------|-------------|----------------------------|-----------------------------------------------|
| 47   | VoteCalled  | kind, caller, one more byte | a vote is called; kind 1 is a return to the lobby, 2 a surrender |
| 48   | VoteCast    | kind, slot, vote (1 yes)   | a player votes; the caller's own vote comes with the call |
| 49   | VoteResult  | kind, result (1 passed)    | the vote resolves, and the server returns to the lobby |

Seen in a game ended by a vote to return to the lobby (47 = 1,0,0; 48 =
1,0,1; then 48 = 1,1,1 and 49 = 1,1 when the other player voted) and in
games ended by surrender (47 = 2,0,1 and 48 = 2,0,1 together, 49 = 2,1
five seconds later). The third byte of VoteCalled is not understood.

## Snapshots

```
start delay          4 bytes
time left            4 bytes; 0xffffffff for no limit
pills                length byte, then: count, and per pill
                       x, y, armour, owner, speed, in tank, reload, just seen, cool down
bases                length byte, then: count, and per base
                       x, y, owner, armour, shells, mines, refuel time, base time (2 bytes), just stopped
starts               length byte, then: count, and per start x, y, direction
map                  run-length rows, as in a BMAPBOLO map file, ending with the 04 FF FF FF run
players              16 records, each a length byte then:
                       slot, in use; and when in use:
                       mx, my, nibble(px, py), frame, on boat,
                       man mx, my, nibble(px, py), frame,
                       name (Pascal), location (Pascal; the country code in version 2),
                       ally count, ally slots
```

The tank's frame is its direction, plus 16 when on a boat. The map's
rows use the nibble run-length code of `bolo_map.c`: each run is a length
byte (the whole run's size), y, start x, end x, then nibbles, high first,
where a nibble 0-7 introduces that many plus one literal terrain nibbles
and 8-15 repeats the next nibble that many minus six times. Squares no run
covers are deep sea.

Terrain codes (map file and MapChange alike): 0 building, 1 river,
2 swamp, 3 crater, 4 road, 5 forest, 6 rubble, 7 grass, 8 shot building,
9 boat, 10-15 the mined forms of 2-7, 255 deep sea.

## attribution.trk

Not in the public source; framing found from one file, fields not decoded:

```
"WBAT"               4 bytes
                     4 bytes (02 00 10 00 in the sample: a version and the 16 slots?)
player table         16 slots of 66 bytes: two bytes, then a 64-byte name
record count         4 bytes, little-endian, at offset 0x428
records              type byte, 4-byte little-endian time, then a fixed payload:
                       type 1: 9 bytes; 2 and 3: 7 bytes; 4, 5 and 6: 4 bytes
```

Record times run at twice the log's tick rate (10 ms game ticks, the
public source's `GAME_TICK_LENGTH`) from about the game's start. Type 5
records end in a map square that matches a `MapChange` in the log, so the
file looks like a per-player account of terrain changes, kills and
captures, presumably for WinBolo.net statistics.
