#!/usr/bin/env python3
"""Measure WinBolo v2 replay regeneration, reporting the time-weighted average rate.

Reuses the parser from measure-base.py (which must sit in the same directory).
"""

import argparse
import importlib.util
import pathlib
from statistics import median
import zipfile

spec = importlib.util.spec_from_file_location("measure_base", pathlib.Path(__file__).with_name("measure-base.py"))
measure_base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measure_base)

TICKS_PER_MINUTE = 3000  # 50 ticks/s.


def average_rate(pulses, start, end):
	"""Units/min per base, per resource: one unit per pulse, spread over the span."""
	return len(pulses) * TICKS_PER_MINUTE / (end - start)


def report(data):
	pulses, transitions, rises, checks, mismatches = measure_base.measure(data)
	game_start = next((tick for tick, label in transitions if label == "Lobby exit"), None)
	replay_end = transitions[-1][0]
	cycle_rates = []
	print("Absolute replay ticks (50/s). Rates: units/min per base, per resource.")
	print("   Start      End  Transition       Pulses  Average  Cycle evidence")
	for (start, label), (end, _) in zip(transitions, transitions[1:]):
		if label == "Lobby exit":
			print("---- game starts ----")
		if end <= start:
			continue
		times = [t for t in pulses if start <= t < end]
		cycles = []
		for count in range(1, 17):
			gaps = [b - a for a, b in zip(times, times[count:])]
			matches = [g for g in gaps if 990 <= g <= 1010]
			if len(gaps) >= 2 and len(matches) >= 0.75 * len(gaps):
				rate = count * TICKS_PER_MINUTE / median(matches)
				cycle_rates.append(rate)
				cycles.append(f"{rate:.3f} (~{count * 3}; {len(matches)}/{len(gaps)} cycles)")
		evidence = "; ".join(cycles) or "inconclusive"
		if cycles and not any(start <= t < end for t in rises):
			evidence += " [no stock increases; cadence only]"
		print(f"{start:8} {end:8}  {label:16} {len(times):6}  {average_rate(times, start, end):7.3f}  {evidence}")
	print()
	if game_start is not None and replay_end > game_start:
		in_game = [t for t in pulses if game_start <= t < replay_end]
		rate = average_rate(in_game, game_start, replay_end)
		print(f"AVERAGE RATE IN GAME (ticks {game_start}-{replay_end}): {rate:.3f} units/min per base, per resource")
	else:
		print("AVERAGE RATE IN GAME: inconclusive (no lobby exit seen)")
	if cycle_rates:
		print(f"MINIMUM RATE SEEN: {min(cycle_rates):.3f} units/min per base, per resource")
		print(f"MAXIMUM RATE SEEN: {max(cycle_rates):.3f} units/min per base, per resource")
	else:
		print("MINIMUM/MAXIMUM RATE SEEN: inconclusive (no segment with cycle evidence)")
	print(f"\nPositive stock events: {len(rises)}; snapshot mismatches: {mismatches}/{checks} fields.")
	print("A pulse is a complete stock-update pass across all bases (requires >1 base).")
	print("Averages count +1 shell/mine/armour per pulse (below the stock cap of 90), spread over the span.")
	print("Cycle evidence: N pulses span 990-1010 ticks in >=75% of at least 2 intervals.")
	print("Minimum/maximum are taken over segments with cycle evidence only.")
	if mismatches:
		print("WARNING: snapshots disagree with tracked stocks; treat the rates with caution.")


def main():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("replay", help="Path to a .wbv replay")
	args = parser.parse_args()
	try:
		with zipfile.ZipFile(args.replay) as archive:
			data = archive.read("log.dat")
		report(data)
	except (OSError, ValueError, KeyError, RuntimeError, zipfile.BadZipFile) as error:
		parser.exit(1, f"Error: {error}\n")


if __name__ == "__main__":
	main()
