# Base resource generation: Bolo and WinBolo

**Controlled follow-up:** the [join/quit experiment](base-generation-experiment.md)
confirms persistence across quits and rounds, while showing that a lobby-only
visit does not necessarily add a timer. It narrows the lobby-history inference
below; the maximum lobby population alone is not the rule.


Measured 2026-09-11. Rates below are **per base, for each of shells, mines
and base armour separately**, before the stock cap of 90 or any consumption.
Time is game time at 50 parser ticks per second.

Bolo's nominal rate is **3 × N units per minute**, where N is the number of
players contributing stock ticks. The supplied WinBolo logs do not follow
one rate determined solely by the current player count: some match Bolo,
while others replenish at the equivalent of six or seven Bolo players.
The expanded run covers **26 distinct WinBolo recordings**; see the additional
logs below. The following table is the original five-log comparison.

| WinBolo replay | Players during play | Measured units/minute | Bolo at that player count | WinBolo/Bolo |
| --- | ---: | ---: | ---: | ---: |
| Chewy somthin' or other, September 5 | 2 | ~18 | 6 | 3× |
| Jelp Toy IV, September 9 | 2 | ~18 | 6 | 3× |
| Dune 1, September 9 | 2 | ~6 | 6 | 1× |
| Chew Toy 3, September 11 | 4, then 3 | 18 throughout | 12, then 9 | 1.5×, then 2× |
| Smol War, this parser's sample | 2 | ~6 | 6 | 1× |

All five WinBolo headers report version 2.0.3, and all parse without warnings.
Player counts come from the recorded roster and joins/quits, not filenames,
maximum-player settings or the number of tanks currently alive. For example,
the Jelp Toy IV filename names Chapu and rooklift, but its playable round has
rooklift and rider; Chapu left during the long lobby.

At these rates, filling an empty, untouched base stock to 90 takes roughly
15 minutes at 6/minute, 7.5 minutes at 12/minute, or 5 minutes at 18/minute.
These are stock units: five base armour units buy one tank armour point.

## Bolo evidence

The Bolo parser's [format documentation](../../ancient_bolo_parser/docs/FORMAT.md) says that every player's
1000-tick flag adds one to **every** base's three stocks, capped at 90.
The [base-tick evidence](../../ancient_bolo_parser/docs/FORMAT.notes.md#ebase-tick--every-players-tick-increments-every-base)
tests this against actual consumption: counting only the owner's ticks
would make thousands of drains impossible. Thus one player contributes
one unit per 20 seconds, or three per minute, to each base.

This run independently checked the timing in both standalone fixtures in
`../ancient_bolo_parser/fixtures/`:

| Fixture | Stock-tick senders | Stock ticks | Consecutive same-sender intervals | Median interval |
| --- | ---: | ---: | ---: | ---: |
| `040601.6` | 2 | 243 | 241 | 1003 ticks = 20.06 s |
| `n20021018.2` | 4 | 1619 | 1615 | 1008 ticks = 20.16 s |

All 1856 measured intervals lie between 900 and 1100 ticks. The small
departure from 1000 is consistent with transmission/timer scheduling and
recording time; the nominal rates should not be read as exact wall-clock
throughput in a particular network game.

## WinBolo evidence

The script reads `BaseSetStock` events with this repository's parser. Periodic
regeneration produces a batch touching every base, including full bases.
Counting complete passes through all bases gives the replenishment schedule even when a base
has reached its cap. Comparing stocks before and after events separately
confirms that these batches really add resources where there is room.
The expanded script counts multiple complete passes on the same tick
separately: one additional replay has two simultaneous replenishments.
This refinement leaves all five original rates unchanged.

| Replay | Global stock batches | Pulses per ~1000 ticks | Measured complete cycle spans |
| --- | ---: | ---: | --- |
| Chewy | 491 | 6 | 485/485 within 997–1000 ticks |
| Jelp Toy IV | 175 | 6 | 169/169 within 995–1000 ticks |
| Dune 1 | 204 | 2 | 202/202 within 998–1000 ticks |
| Chew Toy 3 | 140 | 6 | 134/134 exactly 1000 ticks |
| Smol War | 140 | 2 | 138/138 within 997–1000 ticks |

Cycle spans compare each pulse with the pulse two or six positions later;
these measurements overlap. At 50 ticks/second, six pulses per 1000 ticks
means 18 units/minute, and two means 6 units/minute.

The faster schedule is uneven, not simply one increment every 166.67 ticks.
For example, Chew Toy 3 initially has stock batches at absolute ticks
6556, 6639, 6806, 6889, 7056 and 7306, then repeats the same phases 1000
ticks later. Its game begins at tick 6307. A player quits at tick 26324
(6:40.34 into play), and the same six-pulse schedule continues to the end,
with actual positive stock changes in the three-player portion. Jelp's
schedule also persists after its late quit, although its full stocks mean
that those later batches alone do not measure usable production.

Independent checks on quiet, uncapped stocks show actual accumulation:

| Replay | Base index, resource | Absolute tick interval | Stock change | Units/minute |
| --- | --- | --- | --- | ---: |
| Jelp Toy IV | 0, shells | 2864296–2870296 | 53 → 89 | 18.000 |
| Dune 1 | 6, shells and mines | 34894–78884 | 1 → 89 | 6.001 |
| Chew Toy 3 | 4, shells | 14806–25306 | 26 → 89 | 18.000 |
| Smol War | 11, shells | 46168–82165 | 1 → 73 | 6.001 |

Base indices are zero-based. The JSON also records quiet-growth examples
for all three resources in all five files. Finite windows need not contain
an integer number of cycles: Chewy's longest shell/mines window gives
17.760/minute while its repeating schedule is six pulses per 20 seconds.

The analysis checks event-derived stocks against periodic snapshots and
restarts a quiet-growth measurement on a disagreement, a decrease, a
capture event, a cap, or a different player count at the next increase.
There are occasional event/snapshot disagreements (43, 1, 123, 26 and 34
stock fields respectively, out of tens of thousands of comparisons), so
the script uses snapshots to restore authoritative state. The independent
all-base batch timing does not depend on those reconstructed stocks.

## Additional logs from `wbn_logs`

The directory contains 22 logs. SHA-256 comparison identifies two duplicates
of already measured files: `71a8ff32...` is the Desktop Chewy recording, and
`5efe8316...` is the parser's Smol War sample. Thus it adds **20 distinct
recordings**. A new BuzzSaw recording was also present in the Desktop folder
on the expanded run: four players, 18 units/minute. Together with the original
five, that makes 26 unique recordings, all parsed without warnings.

Map names below follow the last server map-change announcement before play,
since the replay header often names an earlier map. Arrows show changes in
the roster during the recorded replenishment period. Each listed rate remains
constant across those changes, subject to the small timestamp effects above.

| File prefix | Played map | Version | Players | Units/minute per resource |
| --- | --- | --- | --- | ---: |
| `0d3cd166` | Repetitive Stress Injury | 2.0.2 | 2 → 1 | 6 |
| `0e8f05ae` | Beastly Chew Toy Variant | 2.0.2 | 2 | 18 |
| `12be6922` | DH-Oil Rig | 2.0.2 | 2 | 6 |
| `22907f71` | Beastly Chew Toy Variant | 2.0.2 | 4 → 3 | **21** |
| `32d32244` | Pandemonium | 2.0.2 | 3 | 18 |
| `3e4c90a9` | Dogs Playing Poker | 2.0.3 | 2 | 18 |
| `4aaa2605` | Wrim Wram Wrom | 2.0.2 | 1 | 3 |
| `4c598ded` | Chew Toy 3 | 2.0.3 | 2 → 1 | 18 |
| `5c570816` | Directionally Correct | 2.0.2 | 2 → 1 | 6 |
| `5efe8316` | Smol War (duplicate sample) | 2.0.3 | 2 | 6 |
| `6c80a7a7` | JonnyWar I | 2.0.2 | 2 | 18 |
| `719eb79d` | Mosh Pit XXV | 2.0.2 | 1 | 3 |
| `71a8ff32` | Chewy (duplicate Desktop log) | 2.0.3 | 2 | 18 |
| `72b4742a` | O's Witchy | 2.0.2 | 3 → 2 → 1 | **9 throughout** |
| `790f23c5` | Duckfest MMXXVI | 2.0.3 | 2 | 6 |
| `81c56493` | Baringi | 2.0.2 | 2 | 6 |
| `863b5fc4` | Directionally Correct | 2.0.2 | 2 | 6 |
| `872eb349` | Beastly Chew Toy Variant | 2.0.3 | 2 → 1 | 18 |
| `914ffb71` | Schism Toy III | 2.0.3 | 6 | 18 |
| `999446f8` | Triangle | 2.0.2 | 3 | 9 |
| `9be7147d` | Fitzhu | 2.0.2 | 4 | 12 |
| `d97dc50a` | Gothic Toy | 2.0.3 | 4 | 18 |

The expanded sample supplies ordinary 1-, 2-, 3-, 4- and 6-player examples
at 3, 6, 9, 12 and 18 units/minute, respectively. Of the 26 distinct logs,
14 match Bolo's nominal rate at their initial playing roster and 12 exceed
it. This is a convenience sample, not an estimate of how common the issue is.

Three particularly useful findings:

- **A departure does not necessarily reduce production, even in an initially
  normal-rate game.** O's Witchy starts with three players and three pulses
  per 1000 ticks. The first quit is at tick 427286; the next is at 504535,
  leaving two players for 25:44.98. Production remains 9/minute. During that
  two-player period, base 9's shells rise from 1 to 89 over ticks
  468186–497517, or 9.0007/minute. After the second quit the same schedule
  continues for the short remaining solo tail, also with positive stock
  changes. Spectator joins in the two-player period do not alter the schedule.
- **Seven lobby players can leave a seven-player rate with only four playing.**
  In `22907f71`, the recorded lobby reaches seven simultaneous player slots
  at tick 29282, then falls to four before play starts at 33802. The game has
  seven replenishment passes per 1000 ticks, with two occurring at tick 35051
  and again every ~1000 ticks. All 217 measured seven-pulse cycle spans are
  999–1000 ticks. A quiet stock gains 80 units in 11334 ticks (~21.18/minute;
  the finite window cuts across unevenly spaced pulses), and the rate remains
  ~21 after a further quit leaves three players. Counting distinct event
  timestamps alone would incorrectly label this as 18/minute.
- **The fast games cluster by server creation timestamp.** Nine recordings
  share header `server_created = 1787849819`, all at six pulses per 1000 ticks,
  despite starting play with two, four or six players. Four 2.0.2 recordings
  share `1785896099`: three have six pulses and the seven-lobby-player game
  has seven. The timestamp is a useful server-session clue, not an independently
  verified unique server identifier. This is stronger evidence for retained
  server state than a map-specific multiplier or a 2.0.3-only change.

## Interpretation and limits

**Player count matters in Bolo, but current player count is insufficient
to predict the rate in these WinBolo recordings.** The extra repeating
pulses, server timestamp clusters, seven-player lobby and unchanged schedule
after quits suggest additional timers persisting in server state. Stale timers or lobby/roster history are possible
explanations, not established causes; a server setting or another mechanism
cannot be ruled out from these logs alone. The WinBolo rates above describe
these recordings, not a universal rule for every WinBolo version or server.

A controlled follow-up would start a fresh server, measure an uncapped base
with two players, then add/remove players and return to the lobby between
rounds. That would distinguish current-player scaling from retained state.

## Reproduce

From this `winbolo_parser` checkout, with `../ancient_bolo_parser` available
for its Mac Bolo parser and fixtures:

```text
node tools/compare-base-generation.cjs
node tools/compare-base-generation.cjs "C:/path/to/WinBolo logs" "C:/path/to/more/logs"
```

By default the script reads both `~/Desktop/WinBolo logs` and
`~/AppData/Roaming/WinBolo/WinBolo/wbn_logs`, plus this repository's
`samples/smol_war.wbv` and the two standalone Bolo fixtures in the sibling
`ancient_bolo_parser` checkout. Explicit directory arguments
replace the default WinBolo directories. Identical files are counted once
and retained as duplicate aliases in the results. It writes
[`corpus_runs/base-generation-comparison.json`](corpus_runs/base-generation-comparison.json),
including the complete WinBolo pulse timelines, roster events, stock-change
histograms, cycle checks, server creation timestamps, played maps and
quiet-growth examples grouped by player count. It does not modify
either parser or any replay.
