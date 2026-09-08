/*
 * Codec for Bolo "BMAPBOLO" version 1 map files.
 * Faithful port of the reader/writer in bolo_map.c (WinBolo, John Morrison).
 *
 * File layout:
 *   "BMAPBOLO"                        8 bytes, no terminator
 *   version                           1 byte, must be 1
 *   nPills, nBases, nStarts           1 byte each, max 16
 *   pills   x,y,owner,armour,speed    5 bytes each
 *   bases   x,y,owner,armour,shells,mines  6 bytes each
 *   starts  x,y,dir                   3 bytes each
 *   runs    datalen,y,startx,endx + nibble RLE payload
 *   terminator run 04 FF FF FF
 *
 * Nibble RLE (high nibble first): length code 0-7 means the next
 * (code+1) nibbles are literal terrain codes; 8-15 means the next
 * single nibble repeats (code-6) times. Padded to a whole byte.
 * Squares not covered by any run are deep sea.
 */
"use strict";
(function () {

const MAP_SIZE = 256;
const DEEP_SEA = 0xff;

const TERRAIN_NAMES = {
	0: "Building",
	1: "River",
	2: "Swamp",
	3: "Crater",
	4: "Road",
	5: "Forest",
	6: "Rubble",
	7: "Grass",
	8: "Shot building",
	9: "Boat",
	10: "Mined swamp",
	11: "Mined crater",
	12: "Mined road",
	13: "Mined forest",
	14: "Mined rubble",
	15: "Mined grass",
	255: "Deep sea",
};

const MAX_PILLS = 16;
const MAX_BASES = 16;
const MAX_STARTS = 16;

/* WinBolo only saves terrain strictly inside the mine border (21..235);
 * everything else reads back as deep sea (mapGetPos). */
const EDGE_MIN = 20;  /* exclusive */
const EDGE_MAX = 236; /* exclusive */

function new_map() {
	let grid = new Uint8Array(MAP_SIZE * MAP_SIZE);
	grid.fill(DEEP_SEA);
	return { grid, pills: [], bases: [], starts: [] };
}

function get_pos(grid, x, y) {
	if (x > EDGE_MIN && x < EDGE_MAX && y > EDGE_MIN && y < EDGE_MAX) {
		return grid[y * MAP_SIZE + x];
	}
	return DEEP_SEA;
}

function parse_map(bytes) {
	if (bytes.length < 12) throw new Error("File too short");
	let magic = String.fromCharCode(...bytes.subarray(0, 8));
	if (magic !== "BMAPBOLO") throw new Error("Not a Bolo map (bad BMAPBOLO header)");
	if (bytes[8] !== 1) throw new Error(`Unsupported map version ${bytes[8]}`);

	let n_pills = bytes[9], n_bases = bytes[10], n_starts = bytes[11];
	if (n_pills > MAX_PILLS || n_bases > MAX_BASES || n_starts > MAX_STARTS) {
		throw new Error("Too many pills/bases/starts");
	}

	let p = 12;
	let need = n => {
		if (p + n > bytes.length) throw new Error("Unexpected end of file");
	};

	/* Internally owners are 0-16 with 16 = NEUTRAL (WinBolo's own
	 * convention; players are 0-15). Files in the wild store neutral as
	 * 16 or as the classic 0xff — take anything above 15 as neutral. */
	let owner = o => o > 15 ? 16 : o;
	let pills = [];
	for (let i = 0; i < n_pills; i++) {
		need(5);
		pills.push({ x: bytes[p], y: bytes[p + 1], owner: owner(bytes[p + 2]), armour: bytes[p + 3], speed: bytes[p + 4] });
		p += 5;
	}
	let bases = [];
	for (let i = 0; i < n_bases; i++) {
		need(6);
		bases.push({ x: bytes[p], y: bytes[p + 1], owner: owner(bytes[p + 2]), armour: bytes[p + 3], shells: bytes[p + 4], mines: bytes[p + 5] });
		p += 6;
	}
	let starts = [];
	for (let i = 0; i < n_starts; i++) {
		need(3);
		starts.push({ x: bytes[p], y: bytes[p + 1], dir: bytes[p + 2] });
		p += 3;
	}

	let grid = new Uint8Array(MAP_SIZE * MAP_SIZE);
	grid.fill(DEEP_SEA);

	for (;;) {
		/* mapReadRuns tests feof before it tests the header read, so a file that
		 * simply ends is a valid end of the run list and the 04 FF FF FF
		 * terminator is effectively optional. Some editors stop on a different
		 * sentinel (04 99 99 99 seen in the wild), which decodes as a harmless
		 * empty run; we then fall out here like WinBolo does. */
		if (p + 4 > bytes.length) break;
		let datalen = bytes[p], y = bytes[p + 1], startx = bytes[p + 2], endx = bytes[p + 3];
		p += 4;
		if (datalen === 4 && y === 0xff && startx === 0xff && endx === 0xff) break; /* terminator */
		if (datalen < 4) throw new Error(`Bad run length ${datalen} at offset ${p - 4}`);
		let data_bytes = datalen - 4;
		need(data_bytes);

		let nibs = [];
		for (let i = 0; i < data_bytes; i++) {
			nibs.push(bytes[p + i] >> 4, bytes[p + i] & 0x0f);
		}
		p += data_bytes;

		let x = startx, i = 0;
		while (x < endx && i < nibs.length) {
			let code = nibs[i++];
			if (code >= 8) {
				/* code-6 identical squares */
				if (i >= nibs.length) throw new Error("Truncated run payload");
				let t = nibs[i++];
				for (let k = 0; k < code - 6; k++) grid[y * MAP_SIZE + (x++ & 0xff)] = t;
			} else {
				/* code+1 literal squares */
				for (let k = 0; k < code + 1; k++) {
					if (i >= nibs.length) throw new Error("Truncated run payload");
					grid[y * MAP_SIZE + (x++ & 0xff)] = nibs[i++];
				}
			}
		}
		if (x !== endx) throw new Error(`Run for row ${y} ended at ${x}, expected ${endx}`);
	}

	return { grid, pills, bases, starts };
}

/* Port of mapPrepareRun: encodes one run starting at (x,y), returns bytes
 * and the advanced cursor. The terminator falls out naturally when the
 * scan reaches (255,255). */
function prepare_run(grid, x, y) {
	/* Skip deep sea to find the next run (or the end of the map) */
	while (get_pos(grid, x, y) === DEEP_SEA) {
		if (x < 0xff) x++;
		else if (y < 0xff) { x = 0; y++; }
		else break;
	}
	let startx = x;
	let nibs = [];

	if (y < 255) {
		let terrain = get_pos(grid, x, y);
		while (terrain !== DEEP_SEA) {
			if (terrain === get_pos(grid, x + 1, y)) {
				/* identical squares: code 8..15 => run of 2..9 */
				let code = 8;
				x += 2;
				while (code < 15 && get_pos(grid, x, y) === terrain) { code++; x++; }
				nibs.push(code, terrain);
			} else {
				/* different squares: code 0..7 => 1..8 literals */
				let code = 0;
				let ds = x++;
				while (code < 7 && get_pos(grid, x, y) !== DEEP_SEA &&
							 get_pos(grid, x, y) !== get_pos(grid, x + 1, y)) { code++; x++; }
				nibs.push(code);
				while (ds < x) nibs.push(get_pos(grid, ds++, y));
			}
			terrain = get_pos(grid, x, y);
		}
	}

	let data = [];
	for (let i = 0; i < nibs.length; i += 2) {
		data.push((nibs[i] << 4) | ((i + 1 < nibs.length ? nibs[i + 1] : 0) & 0x0f));
	}
	let header = [4 + data.length, y & 0xff, startx & 0xff, x & 0xff];
	return { bytes: header.concat(data), x, y };
}

function serialize_map(map) {
	let out = [];
	for (let i = 0; i < 8; i++) out.push("BMAPBOLO".charCodeAt(i));
	out.push(1, map.pills.length, map.bases.length, map.starts.length);
	/* Internal neutral (16) goes out as the classic 0xff, which nearly
	 * every map in the wild uses. */
	let owner = o => o >= 16 ? 0xff : o;
	for (let p of map.pills) out.push(p.x, p.y, owner(p.owner), p.armour, p.speed);
	for (let b of map.bases) out.push(b.x, b.y, owner(b.owner), b.armour, b.shells, b.mines);
	for (let s of map.starts) out.push(s.x, s.y, s.dir);

	let x = 0, y = 0;
	while (y < 0xff) {
		let run = prepare_run(map.grid, x, y);
		out.push(...run.bytes);
		x = run.x;
		y = run.y;
	}
	return Uint8Array.from(out);
}

const BoloMap = {
	MAP_SIZE, DEEP_SEA, TERRAIN_NAMES, MAX_PILLS, MAX_BASES, MAX_STARTS,
	EDGE_MIN, EDGE_MAX, new_map, parse_map, serialize_map, get_pos,
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloMap;
} else {
	window.BoloMap = BoloMap;
}

})();
