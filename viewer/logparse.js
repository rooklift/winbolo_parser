/* GENERATED FILE - do not edit. Built from src/zip.js, src/inflate.js, src/parse.js
 * by tools/build-viewer-parser.js, for the viewer. Edit src/ and rebuild. */

/* Minimal zip reader: enough to pull the members out of a WinBolo .wbv
 * (a zip written by minizip holding log.dat and, in newer versions,
 * attribution.trk). Entries are located from the central directory, so a
 * data descriptor after the member data does not matter. Only stored and
 * deflated members are understood; the deflate payload is returned
 * compressed for the caller to inflate (see inflate.js), keeping this file
 * free of any decompression code. No zip64, no encryption, no multi-disk
 * archives: a replay is a few MB. */
"use strict";
(function () {

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const END_OF_CENTRAL_MIN = 22;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

function u16(b, p) { return b[p] | (b[p + 1] << 8); }
function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 0x1000000; }

function latin1(b, p, n) {
	let s = "";
	for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + i]);
	return s;
}

/* Offset of the end-of-central-directory record: it sits at the end of
 * the file, followed only by its own comment (at most 65535 bytes). */
function find_end_of_central(bytes) {
	let lo = Math.max(0, bytes.length - END_OF_CENTRAL_MIN - 0xffff);
	for (let p = bytes.length - END_OF_CENTRAL_MIN; p >= lo; p--) {
		if (u32(bytes, p) === END_OF_CENTRAL && p + END_OF_CENTRAL_MIN + u16(bytes, p + 20) <= bytes.length) return p;
	}
	return -1;
}

function is_zip(bytes) {
	return bytes.length >= 4 && u32(bytes, 0) === LOCAL_HEADER;
}

/* Every member of the archive, in central-directory order:
 *   { name, method, crc32, compressed_size, size, data, comment }
 * where data is a view of the member's bytes as stored (compressed when
 * method is 8). The archive comment comes back as .comment on the array. */
function entries(bytes) {
	if (bytes.length < END_OF_CENTRAL_MIN) throw new Error("not a zip file (too short)");
	let end = find_end_of_central(bytes);
	if (end < 0) throw new Error("not a zip file (no end-of-central-directory record)");
	let count = u16(bytes, end + 10);
	let dir_size = u32(bytes, end + 12);
	let dir_offset = u32(bytes, end + 16);
	let comment_len = u16(bytes, end + 20);
	if (dir_offset + dir_size > end) throw new Error("zip central directory out of range");

	let out = [];
	let p = dir_offset;
	for (let i = 0; i < count; i++) {
		if (p + 46 > bytes.length || u32(bytes, p) !== CENTRAL_HEADER) throw new Error("zip central directory is damaged");
		let method = u16(bytes, p + 10);
		let crc32 = u32(bytes, p + 16);
		let compressed_size = u32(bytes, p + 20);
		let size = u32(bytes, p + 24);
		let name_len = u16(bytes, p + 28);
		let extra_len = u16(bytes, p + 30);
		let entry_comment_len = u16(bytes, p + 32);
		let local_offset = u32(bytes, p + 42);
		let name = latin1(bytes, p + 46, name_len);
		let comment = latin1(bytes, p + 46 + name_len + extra_len, entry_comment_len);
		p += 46 + name_len + extra_len + entry_comment_len;

		if (local_offset + 30 > bytes.length || u32(bytes, local_offset) !== LOCAL_HEADER) {
			throw new Error(`zip member ${name}: bad local header`);
		}
		/* the local header's own name and extra field can differ in length
		 * from the central directory's copy, so measure them here */
		let data_start = local_offset + 30 + u16(bytes, local_offset + 26) + u16(bytes, local_offset + 28);
		if (data_start + compressed_size > bytes.length) throw new Error(`zip member ${name}: data out of range`);
		if (method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new Error(`zip member ${name}: unsupported compression method ${method}`);
		out.push({ name, method, crc32, compressed_size, size, comment,
			data: bytes.subarray(data_start, data_start + compressed_size) });
	}
	out.comment = latin1(bytes, end + 22, comment_len);
	return out;
}

/* CRC-32 of a byte array, for checking an inflated member against the
 * value the archive recorded. */
let crc_table = null;

function crc32(bytes) {
	if (!crc_table) {
		crc_table = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
			crc_table[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = crc_table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

const WinBoloZip = { METHOD_STORE, METHOD_DEFLATE, is_zip, entries, crc32 };

if (typeof module !== "undefined" && module.exports) {
	module.exports = WinBoloZip;
} else {
	window.WinBoloZip = WinBoloZip;
}

})();

/* Raw deflate decompression for the zip members of a .wbv, in whichever
 * environment the parser is running: Node's zlib when require() exists,
 * the browser's DecompressionStream otherwise (Chrome 103, Firefox 113,
 * Safari 16.4 and later; Electron and WebView2 have it). Both paths give
 * back a promise of the inflated bytes, so callers are written once. */
"use strict";
(function () {

const NODE = typeof module !== "undefined" && module.exports;

function inflate_raw(bytes) {
	if (NODE) {
		return new Promise((resolve, reject) => {
			try {
				resolve(new Uint8Array(require("zlib").inflateRawSync(bytes)));
			} catch (err) {
				reject(err);
			}
		});
	}
	if (typeof DecompressionStream === "undefined") {
		return Promise.reject(new Error("this browser cannot inflate zip members (no DecompressionStream)"));
	}
	let stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Response(stream).arrayBuffer().then(ab => new Uint8Array(ab));
}

const WinBoloInflate = { inflate_raw };

if (NODE) {
	module.exports = WinBoloInflate;
} else {
	window.WinBoloInflate = WinBoloInflate;
}

})();

/* Parser for WinBolo game logs: the log.dat member of a .wbv archive.
 *
 * The layout follows log.c in the WinBolo source (John Morrison, GPL v2),
 * with the changes of log version 2 found by inspection; docs/FORMAT.md
 * has the write-up. Runs as a classic browser script (window.WinBoloLog)
 * and as a CommonJS module. No DOM use. */
"use strict";
(function () {

const TICKS_PER_SECOND = 50; /* one log tick is one 20 ms server tick */
const LOG_HEADER = "WBOLOMOV";
const SUPPORTED_VERSION = 2;
const MAP_SIZE = 256;
const DEEP_SEA = 0xff;
const NEUTRAL = 0xff;
const MAX_TANKS = 16;

/* Record types of the tick stream */
const REC_QUIT = 0, REC_NOEVENTS = 1, REC_NOEVENTS_LONG = 2, REC_EVENT = 3, REC_EVENT_LONG = 4, REC_SNAPSHOT = 5;

/* Event types, as WinBolo's logitem enum numbers them */
const EVENT = {
	PlayerJoined: 1, PlayerQuit: 2, PlayerLocation: 3, LgmLocation: 4, MapChange: 5, Shell: 6,
	SoundBuild: 7, SoundFarm: 8, SoundShoot: 9, SoundHitTank: 10, SoundHitTree: 11, SoundHitWall: 12,
	SoundMineLay: 13, SoundMineExplode: 14, SoundExplosion: 15, SoundBigExplosion: 16, SoundManDie: 17,
	MessageServer: 18, MessageAll: 19, MessagePlayers: 20, ChangeName: 21,
	AllyRequest: 22, AllyAccept: 23, AllyLeave: 24,
	BaseSetOwner: 25, BaseSetStock: 26, PillSetOwner: 27, PillSetHealth: 28, PillSetPlace: 29, PillSetInTank: 30,
	SaveMap: 31, LostMan: 32, KillPlayer: 33, PlayerRejoin: 34, PlayerLeaving: 35, PlayerDied: 36,
	/* version 2 additions, read from their timing in five replays (see
	 * FORMAT.md): a player's ready toggle in the lobby, the five-second
	 * countdown starting, and the game starting */
	PlayerReady: 39, Countdown: 42, GameStart: 38,
	/* how a game ends: a vote is called, players vote, the result comes;
	 * kind 1 is a return to the lobby, kind 2 a surrender */
	VoteCalled: 47, VoteCast: 48, VoteResult: 49,
};
const VOTE_KINDS = { 1: "return to the lobby", 2: "surrender" };
const EVENT_NAMES = {};
for (let name in EVENT) EVENT_NAMES[EVENT[name]] = name;

/* Shell events carry a "frame": explosion animation stages count down
 * from 8 to 1; a shell in flight is its 16-way direction plus 9. */
const SHELL_FRAME_BASE = 9;
const LGM_HELICOPTER_FRAME = 3;

/* ---------- byte helpers ---------- */

let decoder = null;
function text(bytes, p, n) {
	/* WinBolo is a Windows program: names and chat are in the system's
	 * single-byte code page, near enough always cp1252 */
	if (decoder === null) {
		try { decoder = new TextDecoder("windows-1252"); } catch { decoder = false; }
	}
	if (decoder) return decoder.decode(bytes.subarray(p, p + n));
	let s = "";
	for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[p + i]);
	return s;
}

/* Pascal string at p: length byte then the characters. Returns
 * [string, bytes consumed]. */
function pstring(bytes, p) {
	let n = bytes[p];
	return [text(bytes, p + 1, n), n + 1];
}

function be16(b, p) { return (b[p] << 8) | b[p + 1]; }
function be32(b, p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }
function high(b) { return b >> 4; }
function low(b) { return b & 0x0f; }

/* ---------- header ---------- */

function parse_header(bytes) {
	if (bytes.length < 10 || text(bytes, 0, 8) !== LOG_HEADER) {
		throw new Error("not a WinBolo log (no WBOLOMOV header)");
	}
	let version = bytes[8];
	let p = 9;
	let [map_name, n] = pstring(bytes, p);
	p += n;
	if (p + 8 + 6 + 4 + 32 > bytes.length) throw new Error("WinBolo log header is truncated");
	let h = {
		version,
		map_name,
		game_type: bytes[p],
		hidden_mines: bytes[p + 1] !== 0,
		ai: bytes[p + 2],
		password: bytes[p + 3] !== 0,
		max_players: bytes[p + 4],
		bolo_version: `${bytes[p + 5]}.${bytes[p + 6]}.${bytes[p + 7]}`,
	};
	p += 8;
	h.server_ip = `${bytes[p]}.${bytes[p + 1]}.${bytes[p + 2]}.${bytes[p + 3]}`;
	h.server_port = be16(bytes, p + 4);
	p += 6;
	h.created = be32(bytes, p); /* unix seconds, the server's clock */
	p += 4;
	h.wbn_key = text(bytes, p, 32);
	p += 32;
	h.offset = p;
	return h;
}

const GAME_TYPES = { 1: "Open", 2: "Tournament", 3: "Strict" };

/* ---------- map runs (the map's own RLE, as in bolo_map.c) ---------- */

/* Advance over a run list starting at p; returns the offset after the
 * terminator run (04 FF FF FF). */
function skip_runs(bytes, p) {
	for (;;) {
		if (p + 4 > bytes.length) throw new Error("map runs are truncated");
		let datalen = bytes[p], y = bytes[p + 1];
		if (datalen < 4) throw new Error(`bad map run length ${datalen} at offset ${p}`);
		p += datalen;
		if (y === 0xff) return p;
	}
}

/* Decode a run list into a 256×256 terrain grid (file terrain codes:
 * 0 building … 15 mined grass, 255 deep sea). Nibble RLE, high nibble
 * first: code 0-7 introduces code+1 literal squares, 8-15 repeats the
 * next nibble code-6 times. */
function decode_runs(runs) {
	let grid = new Uint8Array(MAP_SIZE * MAP_SIZE);
	grid.fill(DEEP_SEA);
	let p = 0;
	while (p + 4 <= runs.length) {
		let datalen = runs[p], y = runs[p + 1], startx = runs[p + 2], endx = runs[p + 3];
		if (y === 0xff) break;
		let nib = i => (i & 1) ? (runs[p + 4 + (i >> 1)] & 0x0f) : (runs[p + 4 + (i >> 1)] >> 4);
		let nibs = (datalen - 4) * 2;
		let x = startx, i = 0;
		while (x < endx && i < nibs) {
			let code = nib(i++);
			if (code >= 8) {
				let t = nib(i++);
				for (let k = 0; k < code - 6; k++) grid[y * MAP_SIZE + (x++ & 0xff)] = t;
			} else {
				for (let k = 0; k < code + 1 && i < nibs; k++) grid[y * MAP_SIZE + (x++ & 0xff)] = nib(i++);
			}
		}
		p += datalen;
	}
	return grid;
}

/* ---------- snapshots ---------- */

/* The full game state the server writes at the start and periodically
 * after: pill, base and start tables, the map, and every player slot. */
function parse_snapshot(bytes, p, tick) {
	let s = { tick, offset: p };
	if (p + 8 > bytes.length) throw new Error("snapshot is truncated");
	s.start_delay = be32(bytes, p);
	s.time_left = be32(bytes, p + 4); /* 0xffffffff: no time limit */
	p += 8;

	let n = bytes[p++];
	let table = bytes.subarray(p, p + n);
	p += n;
	s.pills = [];
	for (let i = 0, q = 1; i < table[0] && q + 9 <= table.length; i++, q += 9) {
		s.pills.push({ x: table[q], y: table[q + 1], armour: table[q + 2], owner: table[q + 3], speed: table[q + 4],
			in_tank: table[q + 5] !== 0, reload: table[q + 6], just_seen: table[q + 7], cool_down: table[q + 8] });
	}

	n = bytes[p++];
	table = bytes.subarray(p, p + n);
	p += n;
	s.bases = [];
	for (let i = 0, q = 1; i < table[0] && q + 10 <= table.length; i++, q += 10) {
		s.bases.push({ x: table[q], y: table[q + 1], owner: table[q + 2], armour: table[q + 3], shells: table[q + 4],
			mines: table[q + 5], refuel_time: table[q + 6], base_time: be16(table, q + 7), just_stopped: table[q + 9] });
	}

	n = bytes[p++];
	table = bytes.subarray(p, p + n);
	p += n;
	s.starts = [];
	for (let i = 0, q = 1; i < table[0] && q + 3 <= table.length; i++, q += 3) {
		s.starts.push({ x: table[q], y: table[q + 1], dir: table[q + 2] });
	}

	let runs_start = p;
	p = skip_runs(bytes, p);
	s.runs = bytes.subarray(runs_start, p); /* decoded on demand: see snapshot_grid */

	s.players = [];
	for (let i = 0; i < MAX_TANKS; i++) {
		n = bytes[p++];
		let r = bytes.subarray(p, p + n);
		p += n;
		let player = { slot: r[0], in_use: r[1] !== 0 };
		if (player.in_use && n > 2) {
			player.tank = { mx: r[2], my: r[3], px: high(r[4]), py: low(r[4]), frame: r[5], on_boat: r[6] !== 0 };
			player.lgm = { mx: r[7], my: r[8], px: high(r[9]), py: low(r[9]), frame: r[10] };
			let q = 11;
			let [name, a] = pstring(r, q);
			q += a;
			let [location, b] = pstring(r, q);
			q += b;
			player.name = name;
			player.location = location;
			player.allies = Array.from(r.subarray(q + 1, q + 1 + r[q]));
		}
		s.players.push(player);
	}
	s.end = p;
	return s;
}

/* A snapshot's terrain grid, decoded on first use and cached on it. */
function snapshot_grid(s) {
	if (!s.grid) s.grid = decode_runs(s.runs);
	return s.grid;
}

/* ---------- events ---------- */

/* Decoders for the payload of each known event type: the argument bytes
 * logAddEvent wrote, in its order, read back into named fields. */
const DECODERS = {
	[EVENT.PlayerJoined]: (b, e) => {
		e.player = b[0];
		e.ip = [b[1], b[2], b[3], b[4]];
		/* version 2 puts a two-letter country code where the address was */
		if (b[1] >= 0x41 && b[1] <= 0x5a && b[2] >= 0x41 && b[2] <= 0x5a && b[3] === 0 && b[4] === 0) {
			e.country = String.fromCharCode(b[1], b[2]);
		}
		e.player_name = pstring(b, 5)[0];
	},
	[EVENT.PlayerQuit]: (b, e) => { e.player = b[0]; },
	[EVENT.PlayerLocation]: (b, e) => {
		e.player = b[0];
		e.mx = b[1]; e.my = b[2]; e.px = high(b[3]); e.py = low(b[3]);
		e.dir = high(b[4]); e.on_boat = low(b[4]) !== 0;
		e.in_world = b[1] !== 0 || b[2] !== 0; /* a dead tank sits at 0,0 */
	},
	[EVENT.LgmLocation]: (b, e) => {
		e.player = high(b[0]); e.frame = low(b[0]);
		e.parachute = e.frame === LGM_HELICOPTER_FRAME;
		e.mx = b[1]; e.my = b[2]; e.px = high(b[3]); e.py = low(b[3]);
	},
	[EVENT.MapChange]: (b, e) => { e.x = b[0]; e.y = b[1]; e.terrain = b[2]; },
	[EVENT.Shell]: (b, e) => {
		e.mx = b[0]; e.my = b[1]; e.px = high(b[2]); e.py = low(b[2]);
		e.frame = b[3];
		if (b[3] >= SHELL_FRAME_BASE) e.dir = (b[3] - SHELL_FRAME_BASE) & 15;
		else e.explosion = b[3]; /* animation stage, 8 (fresh) down to 1 */
	},
	[EVENT.MessageServer]: (b, e) => { e.text = pstring(b, 0)[0]; },
	[EVENT.MessageAll]: (b, e) => { e.player = b[0]; e.text = pstring(b, 1)[0]; },
	[EVENT.MessagePlayers]: (b, e) => { e.player = b[0]; e.to = b[1]; e.text = pstring(b, 2)[0]; },
	[EVENT.ChangeName]: (b, e) => { e.player = b[0]; e.player_name = pstring(b, 1)[0]; },
	[EVENT.AllyRequest]: (b, e) => { e.player = b[0]; e.other = b[1]; },
	[EVENT.AllyAccept]: (b, e) => { e.player = b[0]; e.other = b[1]; },
	[EVENT.AllyLeave]: (b, e) => { e.player = b[0]; },
	[EVENT.BaseSetOwner]: (b, e) => { e.base = b[0]; e.owner = b[1]; e.migrate = b[2] !== 0; },
	[EVENT.BaseSetStock]: (b, e) => { e.base = b[0]; e.shells = b[1]; e.mines = b[2]; e.armour = b[3]; },
	[EVENT.PillSetOwner]: (b, e) => { e.pill = b[0]; e.owner = b[1]; e.migrate = b[2] !== 0; },
	[EVENT.PillSetHealth]: (b, e) => { e.pill = high(b[0]); e.armour = low(b[0]); },
	[EVENT.PillSetPlace]: (b, e) => { e.pill = b[0]; e.x = b[1]; e.y = b[2]; },
	[EVENT.PillSetInTank]: (b, e) => { e.pill = high(b[0]); e.in_tank = low(b[0]) !== 0; },
	[EVENT.SaveMap]: (b, e) => { e.player = b[0]; },
	[EVENT.LostMan]: (b, e) => { e.player = b[0]; },
	[EVENT.KillPlayer]: (b, e) => { e.player = b[0]; e.killer = b[1]; },
	[EVENT.PlayerRejoin]: (b, e) => { e.player = b[0]; },
	[EVENT.PlayerLeaving]: (b, e) => { e.player = b[0]; },
	[EVENT.PlayerDied]: (b, e) => { e.player = b[0]; },
	[EVENT.PlayerReady]: (b, e) => { e.player = b[0]; },
	[EVENT.Countdown]: () => {},
	[EVENT.GameStart]: () => {},
	[EVENT.VoteCalled]: (b, e) => { e.kind = b[0]; e.player = b[1]; e.raw = Array.from(b); },
	[EVENT.VoteCast]: (b, e) => { e.kind = b[0]; e.player = b[1]; e.vote = b[2] !== 0; },
	[EVENT.VoteResult]: (b, e) => { e.kind = b[0]; e.passed = b[1] !== 0; },
};
for (let t = EVENT.SoundBuild; t <= EVENT.SoundManDie; t++) {
	DECODERS[t] = (b, e) => { e.x = b[0]; e.y = b[1]; };
}

/* Minimum payload each decoder reads, so a short payload is reported
 * rather than read past. */
const MIN_PAYLOAD = {
	[EVENT.PlayerJoined]: 6, [EVENT.PlayerQuit]: 1, [EVENT.PlayerLocation]: 5, [EVENT.LgmLocation]: 4,
	[EVENT.MapChange]: 3, [EVENT.Shell]: 4, [EVENT.MessageServer]: 1, [EVENT.MessageAll]: 2,
	[EVENT.MessagePlayers]: 3, [EVENT.ChangeName]: 2, [EVENT.AllyRequest]: 2, [EVENT.AllyAccept]: 2,
	[EVENT.AllyLeave]: 1, [EVENT.BaseSetOwner]: 3, [EVENT.BaseSetStock]: 4, [EVENT.PillSetOwner]: 3,
	[EVENT.PillSetHealth]: 1, [EVENT.PillSetPlace]: 3, [EVENT.PillSetInTank]: 1, [EVENT.SaveMap]: 1,
	[EVENT.LostMan]: 1, [EVENT.KillPlayer]: 2, [EVENT.PlayerRejoin]: 1, [EVENT.PlayerLeaving]: 1,
	[EVENT.PlayerDied]: 1, [EVENT.PlayerReady]: 1, [EVENT.Countdown]: 0, [EVENT.GameStart]: 0,
	[EVENT.VoteCalled]: 2, [EVENT.VoteCast]: 3, [EVENT.VoteResult]: 2,
};
for (let t = EVENT.SoundBuild; t <= EVENT.SoundManDie; t++) MIN_PAYLOAD[t] = 2;

function decode_event(type, payload, tick, warnings) {
	let e = { tick, type, name: EVENT_NAMES[type] || `event_${type}` };
	let decode = DECODERS[type];
	if (!decode) {
		e.raw = Array.from(payload); /* unknown to the public source; see FORMAT.md */
		return e;
	}
	if (payload.length < MIN_PAYLOAD[type]) {
		warnings.push(`tick ${tick}: ${e.name} payload is ${payload.length} bytes, expected at least ${MIN_PAYLOAD[type]}`);
		e.raw = Array.from(payload);
		return e;
	}
	decode(payload, e);
	return e;
}

/* ---------- the tick stream ---------- */

/* Generator form of parse_log: yields the fraction of the file consumed
 * every so often (for a progress bar), and returns the parsed log. */
function* parse_steps(bytes) {
	let header = parse_header(bytes);
	if (header.version !== SUPPORTED_VERSION) {
		throw new Error(`WinBolo log version ${header.version} is not supported (only version ${SUPPORTED_VERSION})`);
	}
	let events = [];
	let snapshots = [];
	let warnings = [];
	let tick = 0;
	let p = header.offset;
	let finished = false;
	let next_yield = 0;

	while (p < bytes.length) {
		if (p >= next_yield) {
			yield p / bytes.length;
			next_yield = p + (bytes.length >> 6) + 1;
		}
		let rec = bytes[p];
		if (rec === REC_QUIT) {
			if (p + 1 < bytes.length && bytes[p + 1] !== REC_QUIT) {
				warnings.push(`offset ${p}: quit record without its second byte`);
			}
			p += 2;
			finished = true;
			if (p < bytes.length) warnings.push(`${bytes.length - p} bytes follow the quit record`);
			break;
		} else if (rec === REC_NOEVENTS) {
			if (p + 2 > bytes.length) break;
			tick += bytes[p + 1];
			p += 2;
		} else if (rec === REC_NOEVENTS_LONG) {
			if (p + 3 > bytes.length) break;
			tick += be16(bytes, p + 1);
			p += 3;
		} else if (rec === REC_EVENT || rec === REC_EVENT_LONG) {
			let count;
			if (rec === REC_EVENT) {
				if (p + 2 > bytes.length) break;
				count = bytes[p + 1];
				p += 2;
			} else {
				if (p + 3 > bytes.length) break;
				count = be16(bytes, p + 1);
				p += 3;
			}
			for (let i = 0; i < count; i++) {
				if (p + 3 > bytes.length) {
					warnings.push(`offset ${p}: event block cut short at tick ${tick}`);
					p = bytes.length;
					break;
				}
				let type = bytes[p];
				let len = be16(bytes, p + 1);
				if (p + 3 + len > bytes.length) {
					warnings.push(`offset ${p}: event payload runs past the end of the file at tick ${tick}`);
					p = bytes.length;
					break;
				}
				events.push(decode_event(type, bytes.subarray(p + 3, p + 3 + len), tick, warnings));
				p += 3 + len;
			}
			tick++;
		} else if (rec === REC_SNAPSHOT) {
			let s = parse_snapshot(bytes, p + 1, tick);
			s.event_index = events.length; /* first event at or after this snapshot */
			delete s.end;
			snapshots.push(s);
			p = s.end === undefined ? snapshot_end(bytes, p + 1) : s.end;
		} else {
			warnings.push(`offset ${p}: unknown record type ${rec} at tick ${tick}; stopping`);
			break;
		}
	}
	if (!finished) warnings.push("no quit record: the log was cut off (server still running, or crashed)");
	return { header, events, snapshots, ticks: tick, finished, warnings };
}

/* parse_snapshot reports where it stopped in s.end, which parse_steps
 * strips from the kept object; this re-derives it without keeping it. */
function snapshot_end(bytes, p) {
	return parse_snapshot(bytes, p, 0).end;
}

function parse_log(bytes) {
	let steps = parse_steps(bytes);
	let step = steps.next();
	while (!step.done) step = steps.next();
	return step.value;
}

/* ---------- attribution.trk ----------
 * A second member newer servers add to the archive. It is not in the
 * public source; the framing below was worked out from one file and the
 * fields are left raw. Header: "WBAT", 4 bytes, a 16-slot player table
 * (66 bytes each: two flag bytes then a 64-byte name), a little-endian
 * uint32 record count at 0x428, then records of a type byte, a
 * little-endian uint32 timestamp (10 ms game ticks: twice the log's rate)
 * and a fixed payload. */
const ATTRIBUTION_PAYLOAD = { 1: 9, 2: 7, 3: 7, 4: 4, 5: 4, 6: 4 };

function parse_attribution(bytes) {
	if (bytes.length < 0x42c || text(bytes, 0, 4) !== "WBAT") throw new Error("not a WinBolo attribution file (no WBAT header)");
	let count = bytes[0x428] | (bytes[0x429] << 8) | (bytes[0x42a] << 16) | (bytes[0x42b] * 0x1000000);
	let players = [];
	for (let i = 0; i < MAX_TANKS; i++) {
		let q = 8 + i * 66;
		let name = "";
		for (let j = q + 2; j < q + 66 && bytes[j]; j++) name += String.fromCharCode(bytes[j]);
		players.push({ slot: i, flags: [bytes[q], bytes[q + 1]], name });
	}
	let records = [];
	let p = 0x42c;
	while (p + 5 <= bytes.length) {
		let type = bytes[p];
		let n = ATTRIBUTION_PAYLOAD[type];
		if (n === undefined) throw new Error(`attribution record type ${type} at offset ${p} is unknown`);
		let time = bytes[p + 1] | (bytes[p + 2] << 8) | (bytes[p + 3] << 16) | (bytes[p + 4] * 0x1000000);
		records.push({ time, type, raw: Array.from(bytes.subarray(p + 5, p + 5 + n)) });
		p += 5 + n;
	}
	return { count, players, records, complete: records.length === count && p === bytes.length };
}

/* ---------- the archive ---------- */

/* Open a .wbv (or a bare log.dat): finds and inflates the members, parses
 * the log and, when present, the attribution file. `zip` and `inflate`
 * are the sibling modules, passed in so this file stays free of
 * environment detection. Resolves to { log, attribution, members }. */
async function open_archive(bytes, zip, inflate) {
	if (!zip.is_zip(bytes)) {
		return { log: parse_log(bytes), attribution: null, members: ["log.dat"] };
	}
	let entries = zip.entries(bytes);
	let members = {};
	for (let entry of entries) {
		let data = entry.method === zip.METHOD_STORE ? entry.data : await inflate.inflate_raw(entry.data);
		if (data.length !== entry.size) throw new Error(`${entry.name}: inflated to ${data.length} bytes, expected ${entry.size}`);
		members[entry.name] = data;
	}
	if (!members["log.dat"]) throw new Error("the archive has no log.dat member");
	let log = parse_log(members["log.dat"]);
	let attribution = null;
	if (members["attribution.trk"]) {
		try {
			attribution = parse_attribution(members["attribution.trk"]);
		} catch (err) {
			log.warnings.push(`attribution.trk: ${err.message}`);
		}
	}
	return { log, attribution, members: Object.keys(members), comment: entries.comment };
}

const WinBoloLog = {
	TICKS_PER_SECOND, MAP_SIZE, DEEP_SEA, NEUTRAL, MAX_TANKS, EVENT, EVENT_NAMES, GAME_TYPES, VOTE_KINDS,
	SHELL_FRAME_BASE, LGM_HELICOPTER_FRAME,
	parse_header, parse_steps, parse_log, parse_snapshot, snapshot_grid, decode_runs,
	parse_attribution, open_archive,
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = WinBoloLog;
} else {
	window.WinBoloLog = WinBoloLog;
}

})();
