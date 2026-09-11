# Controlled base-generation experiment

Measured 2026-09-11 from the three files in `~/Desktop/testlog`.
All report WinBolo 2.0.3 and parse without warnings. Rates are per base,
per resource, before the cap of 90. Times below are absolute replay ticks
(50 per second), not time since leaving the lobby.

**The experiment supports replenishment timers that survive player quits
and a return to the lobby. Rejoining the same slot resets its phase without
adding another persistent timer. A clean server returns to the solo rate.**
A player who only visits the lobby does not add a timer in this experiment.
This narrows the earlier interpretation: peak lobby population alone is
not the regeneration rule.

## First file: joins, quits and repeated rejoins

`20260911t111219_Dune_1.wbv`, server creation timestamp `1789125138`.

| Stage | Tick interval | Connected players | Pulses per ~20 seconds | Units/minute |
| --- | --- | ---: | ---: | ---: |
| Start playing alone | 1836–8492 | 1 | 1 | 3 |
| test2 joins | 8492–14266 | 2 | 2 | 6 |
| test3 joins | 14266–20161 | 3 | 3 | 9 |
| test3 quits | 20161–26087 | 2 | 3 | 9 |
| test2 quits | 26087–32428 | 1 | 3 | 9 |
| After three brief rejoins/quits by test2 | 34194–39132 | 1 | 3 | 9 |

The second and third players occupy slots 1 and 2. Each adds a repeating
pulse when joining during play. Neither departure removes that pulse.
Stocks genuinely increase: while only the first player remains, base 1's
shells rise from 51 at tick 26223 to 71 at 32750. This window briefly includes
one rejoin, which does not change the persistent three-pulse rate.

The three rapid rejoin/quit pairs are 32428/32702, 33150/33397 and
33922/34194, all in slot 1. They do not accumulate three extra timers.
Instead, the final rejoin is followed by a pulse at 34918, 996 parser ticks
later, then 35915, 36912, 37909 and 38904. This is consistent with resetting
that slot's timer on rejoin. The other two recurring pulse sequences remain.
The 995–999-tick periods in this recording reflect the small parser-clock
versus simulation-clock difference; nominal periods are approximately 20 s.

## Second file: lobby visits and another round

`20260911t112529_Dune_1.wbv`, the same server creation timestamp `1789125138`.

The lobby starts with test1. test2, test3 and test4 join at ticks 879, 1703
and 2371. They quit at 3911, 3581 and 3253 respectively, leaving only test1
when play starts at 5036.

**Production is still three pulses per ~20 seconds, or 9 units/minute.**
There are 28 pulses in the recorded playing period. All 25 comparisons of a
pulse with the pulse three positions later span 996–998 ticks.

Thus the old three-pulse schedule survives into the next round. The visit
by test4, in a previously unused slot 3, does not create a fourth persistent
pulse. This is direct evidence against treating the maximum lobby population
as the rule. Whether activation happens specifically on entry into play or
another related transition would require further tests or source inspection.

## Third file: clean server

`20260911t113121_Dune_1.wbv`, server creation timestamp `1789126280`.
The user confirms this is the clean server.

Only test1 joins, at tick 380; play starts at 738. Seven pulses occur at
1737, 2735, 3734, 4733, 5731, 6730 and 7729. Consecutive gaps are 998–999
ticks: **one pulse per ~20 seconds, or 3 units/minute**. Base 1's shells rise
from 1 at 2735 to 6 at 7729, independently measuring 3.004 units/minute.

## What this establishes

- Joining during play raises the rate from 3 to 6 to 9/minute.
- Quitting does not lower it in this sequence, including when only one player
  remains.
- Repeated joins in an already activated slot do not add persistent pulses;
  their timing is consistent with restarting that slot's existing timer.
- The extra pulses survive a return to the lobby and starting another round.
- A lobby-only visit by a new fourth slot does not raise the rate here.
- Restarting with a clean server restores normal solo production.

A per-slot timer left enabled after quitting explains these observations.
This is an empirical model, not proof of the exact source-code defect. In
particular, the seven-player lobby seen in the earlier uncontrolled replay
cannot by itself explain its seven-pulse rate: some slots may already have
been activated in earlier play on that server.

## Reproduce and verification

From `winbolo_parser`:

```text
node tools/measure-base-experiment.cjs
node tools/measure-base-experiment.cjs "C:/path/to/testlog"
```

The default directory is a constant near the top of the script. This is a
read-only analysis: it prints JSON to standard output and does not overwrite
the earlier comparison results. It segments the pulse stream at joins,
quits and lobby transitions; counting a whole log's dominant rate would hide
the controlled changes in the first file.

A pulse is a complete pass of `BaseSetStock` through every base. Multiple
passes on one tick count separately. Comparing the event-derived stocks
with snapshots gives zero mismatches across 5664, 1680 and 864 stock-field
checks in the three files. Actual positive stock events also occur in each.
The output includes the event timeline, pulse ticks, segment cycle checks,
parser warnings and SHA-256 hashes of the input files.
