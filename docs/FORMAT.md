# WinBolo replay format

A WinBolo replay (`.wbv`) is a zip archive, written by the server with
minizip, whose archive comment is `WinBolo Log File`. It holds:

| member            | what                                                     |
|-------------------|----------------------------------------------------------|
| `log.dat`         | the game log: header, state snapshots and a tick stream  |
| `attribution.trk` | newer servers only; a record of who did what, where      |

The layout of `log.dat` is that of `log.c` in the WinBolo source (John
Morrison, 1998-2008, GPL v2, e.g. the [milki/winbolo](https://github.com/milki/winbolo)
mirror). The changes of **log version 2** were first worked out by
inspection of replays written by WinBolo 2.0.3, whose source is not
public, and then checked against John Morrison's own specification of the
2.03 format, which named the new events and the attribution track's
records; this document follows his names. Where it says "public source"
it means the last GPL release, which writes log version 0.

All multi-byte integers are big-endian unless stated. Strings are Pascal
strings: a length byte, then that many single-byte (cp1252) characters.

## Header

```
"WBOLOMOV"           8 bytes, no terminator
version              1 byte; 2 in current replays (the public source writes 0)
map name             Pascal string; the map loaded when the log began
game type            1 byte: 1 open, 2 tournament, 3 strict
hidden mines         1 byte, boolean
AI                   1 byte (allow computer tanks: 0 no, 1 yes, 2 yes with advantage, 3 full)
password             1 byte, boolean
max players          1 byte
WinBolo version      3 bytes, major.minor.revision
server address       4 bytes IPv4, then 2 bytes port (2.03 writes zeros)
game creation time   4 bytes, unix seconds by the server's clock; when the server
                     started, not this game: it survives a return to the lobby
WinBolo.net key      32 bytes: the game's WinBolo.net server key
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
| 2    | no events, long       | 2 bytes, **little-endian**: as above, 256 or more ticks |
| 3    | events                | 1 byte: the number of events in this tick, then them |
| 4    | events, long          | 2 bytes: as above, 256 or more events                |
| 5    | snapshot              | the full game state, below; takes no tick            |

An events record is one tick. A no-events record is that many ticks. A
snapshot is written between ticks and describes the state after the events
before it: the server flushes the pending tick before writing one. The
server writes a snapshot at the start and then every 125 ticks (2.5 s;
600 in the public source), skipping the write when nothing has happened
since the last one.

The long no-events count is little-endian, the one count in the stream
that is (the 2.03 specification says big-endian; the bytes say otherwise:
read little-endian every such count in three logs is 256 or more, as a
writer that uses the short record up to 255 produces, and read big-endian
they are noise). Reading it big-endian turns a five-second wait into
minutes.

**The no-events record after a snapshot is one tick too long.** Nearly
every snapshot is followed by a no-events record of 1, in the middle of
play, and no game tick happens in it: a shell in flight across the
snapshot moves one step, not two, and the attribution track's 10 ms
clock, which does not count it, agrees to within a tick over a round
once it is dropped. When the game is quiet the extra tick is folded into
a longer no-events record after the snapshot. The parser takes one tick
off the first no-events record after a snapshot. A reader that keeps it
runs 0.8 % fast, six seconds over a thirteen-minute round; the official
viewer keeps it, and also counts the snapshot record itself and every
no-events record as a tick more, so its clock runs 2 to 3 % ahead of the
game's.

### Version 2 changes to the stream

- **No obfuscation.** The public source XORs every byte of the stream with
  a rolling key (the previous event's type number, seeded from the
  creation time). Version 2 writes plain bytes.
- **Events are length-prefixed.** Each event is a type byte, a 2-byte
  payload length, then the payload. The public source had no length, so
  a reader had to know every type's size; now unknown types can be
  skipped, and the parser does so, keeping their payload raw.
- **New event types** appear, for the lobby, votes and spectators. See
  below. A reader should skip any type it does not know by its length:
  2.04 adds a type 53, and more may follow.

## Events

Type numbers are the public `logitem` enum's. Payload fields are the
arguments `logAddEvent` was given, in order; "nibble(a, b)" is one byte
with a in the high nibble and b in the low.

| type | name              | payload                                                       |
|------|-------------------|---------------------------------------------------------------|
| 1    | PlayerJoined      | slot, 4 bytes, name. In version 0 the 4 bytes were the player's IPv4 address; from version 1 they are a two-letter country code, an account flags byte (bit 0 a WinBolo.net account, bit 1 a Steam account, bit 5 a bot) and a reserved zero |
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

The lobby, votes and spectators. A replay opens in the lobby: every
snapshot there is an empty map with no slots in use, and only roster,
chat and vote events are written. LobbyExit marks the game starting; the
next snapshot, a tick later, is the first with the real map and players,
and the first tank position follows a tick after that.

| type | name            | payload                    | what                                          |
|------|-----------------|----------------------------|-----------------------------------------------|
| 37   | LobbyEnter      | none                       | the lobby opens; tick 0 of every log, and again after a vote returns to it |
| 38   | LobbyExit       | none                       | the game begins                               |
| 39   | PlayerReady     | slot                       | a player toggles ready in the lobby           |
| 40   | PlayerUnready   | slot                       | and back                                      |
| 41   | TeamSet         | slot, team                 | a player's lobby team                         |
| 42   | CountdownStart  | none                       | the countdown begins; always 250 ticks (5 s) before LobbyExit |
| 43   | CountdownCancel | none                       |                                               |
| 44   | MapSkipVote     | slot                       | a vote to skip the map                        |
| 45   | MapSkipApplied  | map name                   | the map was skipped for this one              |
| 46   | BalanceApplied  | none                       | the teams were auto-balanced                  |
| 47   | GameVoteStart   | kind, caller, team         | a vote is called; kind 1 is a return to the lobby, 2 a surrender; team 0 puts it to everyone |
| 48   | GameVoteCast    | kind, slot, vote (1 yes)   | a player votes; the caller's own vote comes with the call |
| 49   | GameVoteEnd     | kind, result (1 passed)    | the vote resolves; a passed vote returns the server to the lobby |
| 50   | SpectatorJoined | spectator, 4 bytes, name   | shaped like PlayerJoined; spectators have their own numbering |
| 51   | SpectatorLeft   | spectator, name            |                                               |
| 52   | SpectatorChat   | spectator, text            | reserved; 2.03 never writes it                |

The vote kinds are read from the replays (a game ended by a vote to
return to the lobby: 47 = 1,0,0; 48 = 1,0,1; then 48 = 1,1,1 and 49 = 1,1
when the other player voted; games ended by surrender: 47 = 2,3,1 and 48
= 2,3,1 together, 49 = 2,1 five seconds later). SaveMap (31) is never
written by 2.03 according to the specification, although the viewer
handles it if it appears.

## Snapshots

```
start delay          4 bytes, ms until the game starts
game length          4 bytes, ms; no limit is 0 by the specification, 0xffffffff in every replay seen
pills                length byte, then: count, and per pill
                       x, y, armour, owner, speed, in tank, reload, just seen, cool down
bases                length byte, then: count, and per base
                       x, y, owner, armour, shells, mines, refuel time, base time (2 bytes,
                       little-endian: the one such field in the log), just stopped
starts               length byte, then: count, and per start x, y, direction
map                  run-length rows, as in a BMAPBOLO map file, ending with the 04 FF FF FF run
players              16 records, each a length byte then:
                       slot, in use; and when in use:
                       mx, my, nibble(px, py), frame, on boat,
                       man mx, my, nibble(px, py), frame,
                       name (Pascal), location (Pascal, free text; the country code in version 2),
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

The server's own record of who did what to whom, written only by
server-side recordings, and the raw material for post-game statistics.
It is not needed to play a replay back. Its layout is from John
Morrison's specification: **everything in it is little-endian**, an image
of the server's packed structures.

```
"WBAT"               4 bytes, no terminator
version              1 byte; 2
truncated            1 byte; 1 if the 64 MB per-round cap dropped records
slot count           2 bytes; 16
slot identities      16 × 66 bytes: bot (1 byte), team (1 byte), name (64 bytes, NUL-padded)
record count         4 bytes, at offset 1064
records              type byte, 4-byte tick, then a fixed payload by type
```

Record ticks are the server's internal 10 ms steps, twice the log's rate,
counted from the start of the round, and the offset is not stored. With
the tick after each snapshot dropped (above) they match the log's ticks
exactly: from LobbyExit in 2.0.3 logs, where the lobby countdown precedes
it, and five seconds after LobbyExit in 2.0.2 logs, which write LobbyExit
as the countdown starts and hold the tanks placed but still until it
ends. Records carry no length, so a reader that meets a type it does not
know must stop.

| type | name     | payload                                                                  |
|------|----------|--------------------------------------------------------------------------|
| 1    | damage   | source (0 unknown, 1 shell, 2 mine), target (0 tank, 1 pill, 2 base), target index, attacker, amount (2 bytes), destroyed, x, y |
| 2    | kill     | killer, killed, death cause, carried pills, trees wasted, x, y            |
| 3    | capture  | target (0 pill, 1 base), target index, new owner, previous owner, class (0 was neutral, 1 from an enemy, 2 from an ally), x, y |
| 4    | lgm lost | victim, killer, x, y                                                     |
| 5    | action   | player, action (0 farm, 1 build, 2 lay mine, 3 fire), x, y               |
| 6    | pickup   | picker, pill index, x, y: a dead pillbox scooped up                      |

A player field of 255 is no one: splash and chain damage has no attacker,
an environmental death no killer. `amount` is the armour a hit removed;
`destroyed` is set when it took a pillbox to zero. The death cause,
carried pills and trees wasted are server-internal values that appear
nowhere else. Squares are 0 when unknown.
