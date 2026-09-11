#!/usr/bin/env python3
"""Measure WinBolo v2 replay regeneration; standalone, Python standard library only."""

import argparse
from collections import Counter
from statistics import median
import zipfile


def read_log(data):
	"""Yield (tick, type, payload), decoding only snapshots and relevant events."""
	position = 0

	def take(size):
		nonlocal position
		if position + size > len(data):
			raise ValueError(f"Truncated log at byte {position}")
		result = data[position:position + size]
		position += size
		return result

	def number(size=1, order="big"):
		return int.from_bytes(take(size), order)

	def table():
		return take(number())

	if take(8) != b"WBOLOMOV":
		raise ValueError("Not a WinBolo log")
	if number() != 2:
		raise ValueError("Only log format version 2 is supported")
	table()  # Map name.
	take(50)  # Remaining fixed-size header fields.
	tick, after_snapshot = 0, False
	while position < len(data):
		record = number()
		if record == 0:
			if number() != 0 or position != len(data):
				raise ValueError("Invalid end-of-log record or trailing data")
			yield tick, "end", None
			return
		if record in (1, 2):
			idle = number(record, "little")
			tick += max(0, idle - int(after_snapshot))
			after_snapshot = False
		elif record in (3, 4):
			for _ in range(number(record - 2)):
				event = number()
				payload = take(number(2))
				if event in (1, 2, 26, 37, 38):
					minimum = {1: 6, 2: 1, 26: 4, 37: 0, 38: 0}[event]
					if len(payload) < minimum:
						raise ValueError(f"Short event {event} at tick {tick}")
					yield tick, event, payload
			tick += 1
			after_snapshot = False
		elif record == 5:
			take(8)
			table()  # Pills.
			bases = table()
			if not bases or len(bases) != 1 + bases[0] * 10:
				raise ValueError(f"Invalid base table at tick {tick}")
			stocks = [tuple(bases[i + k] for k in (4, 5, 3))
				for i in range(1, len(bases), 10)]  # Shells, mines, armour.
			table()  # Starts.
			while True:
				size, y, _, _ = take(4)
				if size < 4:
					raise ValueError(f"Invalid map run at tick {tick}")
				take(size - 4)
				if y == 255:
					break
			for _ in range(16):
				table()  # Player slots.
			yield tick, "snapshot", stocks
			after_snapshot = True
		else:
			raise ValueError(f"Unknown record {record} at byte {position - 1}")
	raise ValueError("Log has no end record (possibly still recording or truncated)")


def measure(data):
	stocks, pulses, transitions, rises = [], [], [(0, "Start")], []
	batch, batch_tick = Counter(), None
	checks, mismatches = 0, 0

	def flush():
		# A drain on one base cannot add a complete pass across multiple bases.
		if len(stocks) > 1 and len(batch) == len(stocks):
			pulses.extend([batch_tick] * min(batch.values()))
		batch.clear()

	for tick, event, payload in read_log(data):
		if tick != batch_tick or event in ("snapshot", "end"):
			flush()
			batch_tick = tick
		if event == "snapshot":
			for previous, current in zip(stocks, payload):
				checks += 3
				mismatches += sum(a != b for a, b in zip(previous, current))
			stocks = payload
		elif event == 26:
			base = payload[0]
			if base >= len(stocks):
				raise ValueError(f"Unknown base {base} at tick {tick}")
			current = tuple(payload[1:4])
			if any(a > b for a, b in zip(current, stocks[base])):
				rises.append(tick)
			stocks[base] = current
			batch[base] += 1
		elif event in (1, 2, 37, 38):
			label = {1: "Join", 2: "Quit", 37: "Lobby enter", 38: "Lobby exit"}[event]
			if event in (1, 2):
				label += f" slot {payload[0]}"
			transitions.append((tick, label))
	transitions.append((tick, "End"))
	return pulses, transitions, rises, checks, mismatches


def report(data):
	pulses, transitions, rises, checks, mismatches = measure(data)
	highest_rate = None
	print("Absolute replay ticks (50/s). Rates: units/min per base, per resource.")
	print("   Start      End  Transition       Pulses  Observed rate (cycle evidence)")
	for (start, label), (end, _) in zip(transitions, transitions[1:]):
		if label == "Lobby exit":
			print("---- game starts ----")
		if end <= start:
			continue
		times = [t for t in pulses if start <= t < end]
		rates = []
		for count in range(1, 17):
			gaps = [b - a for a, b in zip(times, times[count:])]
			matches = [g for g in gaps if 990 <= g <= 1010]
			if len(gaps) >= 2 and len(matches) >= 0.75 * len(gaps):
				rate = count * 3000 / median(matches)
				if highest_rate is None or rate > highest_rate:
					highest_rate = rate
				rates.append(f"{rate:.3f} (~{count * 3}; {len(matches)}/{len(gaps)} cycles)")
		result = "; ".join(rates) or "inconclusive"
		if rates and not any(start <= t < end for t in rises):
			result += " [no stock increases; cadence only]"
		print(f"{start:8} {end:8}  {label:16} {len(times):6}  {result}")
	highest_result = "inconclusive" if highest_rate is None else f"{highest_rate:.3f} units/min per base, per resource"
	print(f"\nHIGHEST RATE SEEN: {highest_result}\n")
	print(f"Positive stock events: {len(rises)}; snapshot mismatches: {mismatches}/{checks} fields.")
	print("A pulse is a complete stock-update pass across all bases (requires >1 base).")
	print("Rates infer +1 shell/mine/armour per pulse below the stock cap of 90.")
	print("Cycle evidence: N pulses span 990-1010 ticks in >=75% of at least 2 intervals.")
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

