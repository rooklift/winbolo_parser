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
const SUPPORTED_VERSIONS = [2, 3];
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
	/* version 2 additions, named as in John Morrison's 2.03 format
	 * specification (see FORMAT.md): the lobby, votes and spectators */
	LobbyEnter: 37, LobbyExit: 38, PlayerReady: 39, PlayerUnready: 40, TeamSet: 41,
	CountdownStart: 42, CountdownCancel: 43, MapSkipVote: 44, MapSkipApplied: 45, BalanceApplied: 46,
	GameVoteStart: 47, GameVoteCast: 48, GameVoteEnd: 49,
	SpectatorJoined: 50, SpectatorLeft: 51, SpectatorChat: 52,
	/* WinBolo 2.1 additions, named as in its log.h: lobby settings, smart
	 * pings, tank stocks and modifiers, and what a scenario script did */
	GameSettings: 53, Ping: 54, TankSetStock: 55, TankSetModifiers: 56, EntityChange: 57, EntityMasks: 58,
	ServerText: 59, GameTimeSet: 60, RuleSet: 61, ScnPanel: 62, ScnScore: 63, ScnAnnounce: 64, ScnMarker: 65,
	ScnHint: 66, ServerTick: 67, ScnStatus: 68, VoiceEveryone: 69,
};
/* Vote kinds, from the replays: 1 is a return to the lobby, 2 a surrender */
const VOTE_KINDS = { 1: "return to the lobby", 2: "surrender" };
/* Smart ping kinds (Ping events) */
const PING_KINDS = { 0: "standard", 1: "caution", 2: "assist me", 3: "attack", 4: "on my way", 5: "bot command" };
/* Which list an EntityChange names */
const ENTITY_PILL = 0, ENTITY_BASE = 1, ENTITY_START = 2;
/* The rules a RuleSet names, by index: SIM_RULE_LIST in WinBolo's
 * sim_rules_names.h, whose order is the index. New rules go on the end,
 * so the list only grows; the last, man_bless_tile_terrain_speed, came
 * after 2.1 itself. */
const RULE_NAMES = [
	"tank_reload_ticks", "tank_full_shells", "tank_full_mines", "tank_full_trees", "tank_full_armour",
	"tank_death_ticks", "tank_water_ticks", "shell_damage", "mine_damage", "mine_damage_range",
	"mine_fatal_divisor", "water_loss_shells", "water_loss_mines", "just_fired_ticks",
	"tree_hide_distance", "gunsight_min", "gunsight_max", "tank_accel_rate", "tank_decel_rate",
	"tank_brake_rate", "tank_autoslow_rate", "tank_min_move", "tank_hit_radius",
	"tank_collision_distance", "tank_nudge_threshold", "tank_nudge_amount", "tank_nudge_iterations",
	"tank_bump_decay_shift", "tank_pill_pickup_inset", "tank_boat_exit_inset", "tank_slide_step",
	"tank_wall_glide", "speed_road", "speed_grass", "speed_forest", "speed_river", "speed_swamp",
	"speed_crater", "speed_rubble", "speed_boat", "speed_deep_sea", "speed_refuel_base", "turn_road",
	"turn_grass", "turn_forest", "turn_river", "turn_swamp", "turn_crater", "turn_rubble",
	"turn_boat", "turn_deep_sea", "turn_refuel_base", "man_speed_road", "man_speed_grass",
	"man_speed_forest", "man_speed_river", "man_speed_swamp", "man_speed_crater", "man_speed_rubble",
	"man_speed_boat", "man_speed_deep_sea", "man_speed_refuel_base", "shell_life", "shell_speed",
	"shell_start_add", "lgm_build_ticks", "lgm_cost_road", "lgm_cost_building",
	"lgm_cost_repair_building", "lgm_cost_pill_repair", "lgm_cost_boat", "lgm_cost_pill_new",
	"lgm_cost_mine", "lgm_pill_repair_load", "lgm_gather_trees", "lgm_helicopter_speed",
	"lgm_arrive_tolerance", "lgm_return_tolerance", "lgm_pill_drop_search", "lgm_boat_leave_offset",
	"lgm_boat_return_offset", "pill_max_armour", "pill_attack_ticks", "pill_attack_min_ticks",
	"pill_cooldown_ticks", "pill_repair_amount", "pill_range", "pill_shell_damage",
	"pill_angry_divisor", "pill_fire_length", "pill_base_defend_range", "pill_aim_iterations",
	"pill_massage_range", "pill_massage_cosine", "base_full_armour", "base_full_shells",
	"base_full_mines", "base_capture_armour", "base_hit_armour", "base_min_armour", "base_min_shells",
	"base_min_mines", "base_armour_give", "base_shells_give", "base_mines_give",
	"base_refuel_armour_ticks", "base_refuel_shells_ticks", "base_refuel_mines_ticks",
	"base_regen_ticks", "base_status_range", "base_reveal_range", "building_life", "rubble_life",
	"grass_life", "swamp_life", "mine_fuse_ticks", "big_explosion_threshold", "tank_explosion_damage",
	"tank_explosion_length", "tank_explosion_move", "tank_explosion_update_ticks",
	"tank_explosion_width", "tank_explosion_height", "start_tank_range", "start_pill_range",
	"start_base_range", "start_spawn_separation", "start_scatter_max", "start_neutral_threshold_pct",
	"sound_soft_range", "sound_none_range", "flood_fill_ticks", "tree_grow_ticks",
	"tree_grow_initial_ticks", "tree_grow_initial_score", "tree_weight_forest", "tree_weight_grass",
	"tree_weight_river", "tree_weight_boat", "tree_weight_deep_sea", "tree_weight_swamp",
	"tree_weight_rubble", "tree_weight_building", "tree_weight_half_building", "tree_weight_crater",
	"tree_weight_road", "tree_weight_mine", "pill_shell_cap", "pill_max_shells_at_tank",
	"pill_base_defend_shape", "tank_slide_mac", "tank_slide_armour_bonus", "pill_aim_mac",
	"tank_collision_mac", "tank_deep_sea_safe", "man_bless_tile_terrain_speed",
];
/* Visibility policies of the GameSettings view byte, two bits each */
const VIEW_POLICIES = { 0: "always", 1: "key", 2: "decay", 3: "off" };
/* PlayerJoined account flags */
const ACCOUNT_WBN = 1, ACCOUNT_STEAM = 2, ACCOUNT_BOT = 32;
const EVENT_NAMES = {};
for (let name in EVENT) EVENT_NAMES[EVENT[name]] = name;

/* Shell events carry a "frame": explosion animation stages count down
 * from 8 to 1; a shell in flight is its 16-way direction plus 9. */
const SHELL_FRAME_BASE = 9;
const LGM_HELICOPTER_FRAME = 3;

/* WinBolo 2.1's limits on what a scenario writes, from scenario_panel.h
 * and its replay-format.md; its own viewer ignores a record past them */
const TEAMS = 16;                  /* team 0 is everyone, then 1-15 */
const MAX_ENTITIES = 16;           /* pillboxes, bases or starts in a list */
const MARKERS = 16;
const PANEL_COLOURS = 16;
const PANEL_MAX = 1017;            /* bytes in a panel's list */
const PANEL_ITEMS_MAX = 128;       /* primitives in a list, a size mark counting as one */
const PANEL_TEXT_MAX = 48;
const SCORE_LABEL_MAX = 15;
const LINE_MAX = 128;              /* an announcement or a status line */
const HINT_VERB_MAX = 63;

/* ---------- byte helpers ---------- */

let decoder = null, utf8_decoder = null;
function text(bytes, p, n) {
	let b = bytes.subarray(p, p + n);
	/* WinBolo 2 keeps names and chat in UTF-8; the classic Windows program
	 * used the system's single-byte code page, near enough always cp1252.
	 * Bytes that are not valid UTF-8 are read as the latter. */
	if (utf8_decoder === null) {
		try { utf8_decoder = new TextDecoder("utf-8", { fatal: true }); } catch { utf8_decoder = false; }
	}
	if (utf8_decoder && b.some(c => c >= 0x80)) {
		try { return utf8_decoder.decode(b); } catch { /* not UTF-8 */ }
	}
	if (decoder === null) {
		try { decoder = new TextDecoder("windows-1252"); } catch { decoder = false; }
	}
	if (decoder) return decoder.decode(b);
	let s = "";
	for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
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
function be_double(b, p) { return new DataView(b.buffer, b.byteOffset + p, 8).getFloat64(0, false); }

/* A Pascal string at p that ends within b and is at most max long */
function pstring_fits(b, p, max = 255) { return p < b.length && b[p] <= max && p + 1 + b[p] <= b.length; }
/* A scenario's destination: a team (0 everyone) and a player (0xff everyone) */
function destination_ok(team, player) { return team < TEAMS && (player === NEUTRAL || player < MAX_TANKS); }
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

const GAME_TYPES = { 1: "Open", 2: "Tournament", 3: "Strict", 4: "Scripted" };

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
	s.game_length = be32(bytes, p + 4); /* ms; 0 or 0xffffffff: no time limit */
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
			mines: table[q + 5], refuel_time: table[q + 6], base_time: table[q + 7] | (table[q + 8] << 8) /* little-endian, alone in the log */, just_stopped: table[q + 9] });
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
		/* WinBolo 2.1 can hold a seat before its tank is built: in use, but
		 * with nothing after the flag, so no tank, man or name */
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
			q += 1 + r[q];
			/* WinBolo 2.1 appends the tank's stocks; older logs end here */
			if (q + 4 <= n) player.stocks = { shells: r[q], mines: r[q + 1], armour: r[q + 2], trees: r[q + 3] };
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

/* A scenario panel's display list, as scnPanelParse in WinBolo 2.1's
 * scenario_panel.c reads it: primitives one after another, each an opcode
 * and fixed operands. Returns the items, or null for a list that would be
 * refused whole. A text, name or timer at the large size travels as the
 * normal size followed by a size mark, a rect of 2, 0, 0, 0, 0, 0, which
 * is folded back into it. */
const PANEL_OPS = { 1: "rect", 2: "line", 3: "text", 4: "name", 5: "sprite", 6: "bar", 7: "timer" };
const PANEL_OPERANDS = { 1: 6, 2: 5, 3: 6, 4: 6, 5: 3, 6: 9, 7: 10 };
const PANEL_SIZE_NORMAL = 1, PANEL_SIZE_LARGE = 2;
function panel_items(b) {
	let items = [], wire = 0;
	let is_mark = p => b.length - p >= 7 && b[p] === 1 && b[p + 1] === PANEL_SIZE_LARGE && b.subarray(p + 2, p + 7).every(x => x === 0);
	for (let p = 0; p < b.length;) {
		let op = b[p], n = PANEL_OPERANDS[op];
		if (!n || p + 1 + n > b.length || ++wire > PANEL_ITEMS_MAX) return null;
		let a = b.subarray(p + 1, p + 1 + n);
		let item = { op: PANEL_OPS[op] };
		if (op === 1) {
			/* a size mark anywhere but straight after a normal-size item is refused */
			if (is_mark(p)) return null;
			Object.assign(item, { x: a[0], y: a[1], w: a[2], h: a[3], colour: a[4], fill: a[5] !== 0 });
			if (a[5] > 1) return null;
		} else if (op === 2) {
			Object.assign(item, { x0: a[0], y0: a[1], x1: a[2], y1: a[3], colour: a[4] });
		} else if (op === 5) {
			Object.assign(item, { x: a[0], y: a[1], tile: a[2] });
		} else if (op === 6) {
			Object.assign(item, { x: a[0], y: a[1], w: a[2], h: a[3], colour: a[4], value: be16(a, 5), max: be16(a, 7) });
		} else {
			/* text, name and timer: x, y, colour, size (0 small, 1 normal),
			 * align (0 left, 1 centre, 2 right), then their own */
			if (a[3] > PANEL_SIZE_NORMAL || a[4] > 2) return null;
			Object.assign(item, { x: a[0], y: a[1], colour: a[2], size: a[3], align: a[4] });
			if (op === 3) {
				let len = a[5];
				if (len > PANEL_TEXT_MAX || p + 1 + n + len > b.length) return null;
				let t = b.subarray(p + 1 + n, p + 1 + n + len);
				if (t.some(c => c < 0x20 || c === 0x7f)) return null;
				item.text = text(t, 0, len);
				n += len;
			} else if (op === 4) {
				if (a[5] >= MAX_TANKS) return null;
				item.player = a[5];
			} else {
				if (a[5] > 1) return null;
				item.count_up = a[5] === 1;
				item.server_tick = be32(a, 6); /* counting down to it, or up from it */
			}
		}
		if (item.colour >= PANEL_COLOURS) return null;
		p += 1 + n;
		if (item.size === PANEL_SIZE_NORMAL && is_mark(p)) {
			if (++wire > PANEL_ITEMS_MAX) return null;
			item.size = PANEL_SIZE_LARGE;
			p += 7;
		}
		items.push(item);
	}
	return items;
}

/* Decoders for the payload of each known event type: the argument bytes
 * logAddEvent wrote, in its order, read back into named fields. */
const DECODERS = {
	[EVENT.PlayerJoined]: (b, e, log_version) => {
		e.player = b[0];
		if (log_version === 0) {
			e.ip = [b[1], b[2], b[3], b[4]]; /* version 0 logged the player's address */
		} else {
			/* versions 1 through 3: a two-letter country code, account flags, a reserved byte */
			if (b[1] || b[2]) e.country = String.fromCharCode(b[1], b[2]);
			e.account_flags = b[3];
			e.wbn_account = (b[3] & ACCOUNT_WBN) !== 0;
			e.steam_account = (b[3] & ACCOUNT_STEAM) !== 0;
			e.bot = (b[3] & ACCOUNT_BOT) !== 0;
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
	[EVENT.PillSetHealth]: (b, e, log_version) => {
		e.pill = log_version >= 3 ? b[0] : high(b[0]);
		e.armour = log_version >= 3 ? b[1] : low(b[0]);
	},
	[EVENT.PillSetPlace]: (b, e) => { e.pill = b[0]; e.x = b[1]; e.y = b[2]; },
	[EVENT.PillSetInTank]: (b, e) => { e.pill = high(b[0]); e.in_tank = low(b[0]) !== 0; },
	[EVENT.SaveMap]: (b, e) => { e.player = b[0]; },
	[EVENT.LostMan]: (b, e) => { e.player = b[0]; },
	[EVENT.KillPlayer]: (b, e) => { e.player = b[0]; e.killer = b[1]; },
	[EVENT.PlayerRejoin]: (b, e) => { e.player = b[0]; },
	[EVENT.PlayerLeaving]: (b, e) => { e.player = b[0]; },
	[EVENT.PlayerDied]: (b, e) => { e.player = b[0]; },
	[EVENT.LobbyEnter]: () => {},
	[EVENT.LobbyExit]: () => {},
	[EVENT.PlayerReady]: (b, e) => { e.player = b[0]; },
	[EVENT.PlayerUnready]: (b, e) => { e.player = b[0]; },
	[EVENT.TeamSet]: (b, e) => { e.player = b[0]; e.team = b[1]; },
	[EVENT.CountdownStart]: () => {},
	[EVENT.CountdownCancel]: () => {},
	[EVENT.MapSkipVote]: (b, e) => { e.player = b[0]; },
	[EVENT.MapSkipApplied]: (b, e) => { e.map_name = pstring(b, 0)[0]; },
	[EVENT.BalanceApplied]: () => {},
	[EVENT.GameVoteStart]: (b, e) => { e.kind = b[0]; e.player = b[1]; e.team = b[2]; /* 0: everyone votes */ },
	[EVENT.GameVoteCast]: (b, e) => { e.kind = b[0]; e.player = b[1]; e.vote = b[2] !== 0; },
	[EVENT.GameVoteEnd]: (b, e) => { e.kind = b[0]; e.passed = b[1] !== 0; },
	[EVENT.SpectatorJoined]: (b, e) => {
		e.spectator = b[0];
		if (b[1] || b[2]) e.country = String.fromCharCode(b[1], b[2]);
		e.account_flags = b[3];
		e.player_name = pstring(b, 5)[0];
	},
	[EVENT.SpectatorLeft]: (b, e) => { e.spectator = b[0]; e.player_name = pstring(b, 1)[0]; },
	[EVENT.SpectatorChat]: (b, e) => { e.spectator = b[0]; e.text = pstring(b, 1)[0]; },
	[EVENT.GameSettings]: (b, e) => {
		/* a length-prefixed blob that later servers append to: a byte past
		 * its end reads as zero, the value before the field existed */
		let n = b[0];
		if (b.length < 1 + n) return false;
		let s = i => i < n ? b[1 + i] : 0;
		let views = s(0);
		e.pill_view = VIEW_POLICIES[views & 3];
		e.base_view = VIEW_POLICIES[(views >> 2) & 3];
		e.ally_view = VIEW_POLICIES[(views >> 4) & 3];
		e.classic_mode = (views & 0x40) !== 0;
		e.allies_in_trees = (views & 0x80) !== 0;
		e.pill_view_decay = (s(1) << 8) | s(2); /* seconds */
		e.base_view_decay = (s(3) << 8) | s(4);
		e.ally_view_decay = (s(5) << 8) | s(6);
		e.game_type = s(7);
		e.ai = s(8);
		let flags = s(9);
		e.hidden_mines = (flags & 1) !== 0;
		e.time_limit = (flags & 2) !== 0;
		e.auto_lock = (flags & 4) !== 0;
		e.ranked = (flags & 8) !== 0;
		e.password = (flags & 16) !== 0;
		e.allow_new_players = (flags & 32) !== 0;
		e.classic_overview = (flags & 64) !== 0;
		e.line_of_sight = (flags & 128) !== 0;
		e.time_minutes = (s(10) << 8) | s(11);
		e.lobby_locks = ((s(14) << 8) | s(15)) * 0x10000 + ((s(12) << 8) | s(13)); /* the low half first */
		e.smart_pings_off = (s(16) & 1) !== 0;
		e.positional_sound = (s(16) & 2) !== 0;
	},
	[EVENT.Ping]: (b, e) => {
		if (b[0] >= MAX_TANKS) return false;
		e.player = b[0]; e.kind = b[1];
		e.world_x = be16(b, 2); e.world_y = be16(b, 4); /* 256 to the square */
		e.mx = e.world_x >> 8; e.my = e.world_y >> 8;
	},
	[EVENT.TankSetStock]: (b, e) => {
		if (b[0] >= MAX_TANKS) return false;
		e.player = b[0]; e.shells = b[1]; e.mines = b[2]; e.armour = b[3]; e.trees = b[4];
	},
	[EVENT.TankSetModifiers]: (b, e) => {
		/* percentages, 0 meaning the classic tank; a speed past 255 is a
		 * byte of 255 and then the whole speed as a u16 */
		let n = b[1];
		if (b[0] >= MAX_TANKS || (n !== 6 && n !== 8) || b.length < 2 + n) return false;
		e.player = b[0];
		e.speed = n === 8 ? be16(b, 8) : b[2];
		e.accel = b[3]; e.turn = b[4]; e.reload = b[5]; e.dealt = b[6]; e.taken = b[7];
	},
	[EVENT.EntityChange]: (b, e) => {
		/* a pillbox, base or start joined the map or left it; the record is
		 * the item's, as it now is or as it went */
		let kind = b[0], n = b[3];
		if (kind > ENTITY_START || b[1] >= MAX_ENTITIES || b[2] > 1 || n < (kind === ENTITY_START ? 3 : 6) || b.length < 4 + n) return false;
		e.kind = kind; e.index = b[1]; e.on_map = b[2] !== 0;
		let r = b.subarray(4, 4 + n);
		if (kind === ENTITY_PILL) {
			e.pill = e.index;
			e.record = { x: r[0], y: r[1], owner: r[2], armour: r[3], speed: r[4], in_tank: r[5] !== 0 };
		} else if (kind === ENTITY_BASE) {
			e.base = e.index;
			e.record = { x: r[0], y: r[1], owner: r[2], armour: r[3], shells: r[4], mines: r[5] };
		} else {
			e.start = e.index;
			e.record = { x: r[0], y: r[1], dir: r[2] };
		}
	},
	/* bit i set: item i of that list is on the map */
	[EVENT.EntityMasks]: (b, e) => { e.pills = be16(b, 0); e.bases = be16(b, 2); e.starts = be16(b, 4); },
	/* team 0 is everyone, as is recipient 0xff */
	[EVENT.ServerText]: (b, e) => {
		if (!destination_ok(b[0], b[1]) || !pstring_fits(b, 2)) return false;
		e.team = b[0]; e.to = b[1]; e.text = pstring(b, 2)[0];
	},
	[EVENT.GameTimeSet]: (b, e) => { e.time = be32(b, 0) | 0; /* server ticks, 100 a second */ },
	[EVENT.RuleSet]: (b, e) => {
		/* the value the rule took, as a double whatever the field's type */
		if (b[2] !== 8 || b.length < 11) return false;
		let value = be_double(b, 3);
		if (!Number.isFinite(value)) return false;
		e.rule = be16(b, 0); /* an index into the server's rules table */
		if (e.rule < RULE_NAMES.length) e.rule_name = RULE_NAMES[e.rule];
		e.value = value;
	},
	[EVENT.ScnPanel]: (b, e) => {
		let n = be16(b, 3);
		if ((b[0] & 15) !== 0 || !destination_ok(b[1], b[2]) || n > PANEL_MAX || b.length < 5 + n) return false;
		let list = b.subarray(5, 5 + n);
		let items = panel_items(list);
		if (!items) return false;
		e.panel = b[0] & 15; e.script = b[0] >> 4; e.team = b[1]; e.to = b[2];
		e.list = Array.from(list); /* empty to clear the panel */
		e.items = items;
	},
	[EVENT.ScnScore]: (b, e) => {
		/* kind 0: target is a player; 1: a team, 1-15 */
		let player = b[0] === 0 && b[1] < MAX_TANKS, team = b[0] === 1 && b[1] >= 1 && b[1] < TEAMS;
		if (!(player || team) || !pstring_fits(b, 6, SCORE_LABEL_MAX)) return false;
		e.kind = b[0]; e.target = b[1];
		e.score = be32(b, 2) | 0;
		e.label = pstring(b, 6)[0];
	},
	[EVENT.ScnAnnounce]: (b, e) => {
		if (!destination_ok(b[0], b[1]) || !pstring_fits(b, 4, LINE_MAX)) return false;
		e.team = b[0]; e.to = b[1]; e.time = be16(b, 2); /* server ticks; empty text is the clear */
		let [t, n] = pstring(b, 4);
		e.text = t;
		if (b.length >= 4 + n + 2) { e.x = Math.min(b[4 + n], 254); e.y = Math.min(b[5 + n], 254); }
	},
	[EVENT.ScnMarker]: (b, e) => {
		/* kind 0 a square, 1 a player, 2 the clear, which still carries
		 * the four placement bytes */
		if (b[0] >= MARKERS || b[1] > 2 || !destination_ok(b[2], b[3]) || b[4] !== 4 || b.length < 9
			|| b[8] >= PANEL_COLOURS || (b[1] === 1 && b[7] >= MAX_TANKS)) return false;
		e.id = b[0]; e.kind = b[1]; e.team = b[2]; e.to = b[3];
		e.x = b[5]; e.y = b[6]; e.target = b[7]; e.colour = b[8];
	},
	[EVENT.ScnHint]: (b, e) => {
		if (b[0] >= MAX_TANKS || !pstring_fits(b, 1, HINT_VERB_MAX)) return false;
		e.player = b[0]; e.verb = pstring(b, 1)[0];
	},
	[EVENT.ServerTick]: (b, e) => { e.server_tick = be32(b, 0); },
	[EVENT.ScnStatus]: (b, e) => {
		if (!destination_ok(b[0], b[1]) || !pstring_fits(b, 6, LINE_MAX)) return false;
		e.team = b[0]; e.to = b[1];
		let end = be32(b, 2); /* a server tick, or none */
		e.countdown_to = end === 0xffffffff ? null : end;
		e.text = pstring(b, 6)[0];
	},
	[EVENT.VoiceEveryone]: (b, e) => {
		if (b[0] > 1) return false;
		e.on = b[0] !== 0;
	},
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
	[EVENT.PlayerDied]: 1, [EVENT.LobbyEnter]: 0, [EVENT.LobbyExit]: 0, [EVENT.PlayerReady]: 1,
	[EVENT.PlayerUnready]: 1, [EVENT.TeamSet]: 2, [EVENT.CountdownStart]: 0, [EVENT.CountdownCancel]: 0,
	[EVENT.MapSkipVote]: 1, [EVENT.MapSkipApplied]: 1, [EVENT.BalanceApplied]: 0,
	[EVENT.GameVoteStart]: 3, [EVENT.GameVoteCast]: 3, [EVENT.GameVoteEnd]: 2,
	[EVENT.SpectatorJoined]: 6, [EVENT.SpectatorLeft]: 2, [EVENT.SpectatorChat]: 2,
	[EVENT.GameSettings]: 1, [EVENT.Ping]: 6, [EVENT.TankSetStock]: 5, [EVENT.TankSetModifiers]: 2,
	[EVENT.EntityChange]: 4, [EVENT.EntityMasks]: 6, [EVENT.ServerText]: 3, [EVENT.GameTimeSet]: 4,
	[EVENT.RuleSet]: 3, [EVENT.ScnPanel]: 5, [EVENT.ScnScore]: 7, [EVENT.ScnAnnounce]: 5, [EVENT.ScnMarker]: 5,
	[EVENT.ScnHint]: 2, [EVENT.ServerTick]: 4, [EVENT.ScnStatus]: 7, [EVENT.VoiceEveryone]: 1,
};
for (let t = EVENT.SoundBuild; t <= EVENT.SoundManDie; t++) MIN_PAYLOAD[t] = 2;

function decode_event(type, payload, tick, warnings, log_version) {
	let e = { tick, type, name: EVENT_NAMES[type] || `event_${type}` };
	let decode = DECODERS[type];
	if (!decode) {
		e.raw = Array.from(payload); /* unknown to the public source; see FORMAT.md */
		return e;
	}
	let minimum = type === EVENT.PillSetHealth && log_version >= 3 ? 2 : MIN_PAYLOAD[type];
	if (payload.length < minimum) {
		warnings.push(`tick ${tick}: ${e.name} payload is ${payload.length} bytes, expected at least ${minimum}`);
		e.raw = Array.from(payload);
		return e;
	}
	/* a decoder that finds its payload out of range refuses it whole, as
	 * WinBolo's own viewer ignores it: the event keeps its bytes raw */
	if (decode(payload, e, log_version) === false) {
		warnings.push(`tick ${tick}: ${e.name} payload is out of range`);
		return { tick, type, name: e.name, raw: Array.from(payload) };
	}
	return e;
}

/* ---------- the tick stream ---------- */

/* Generator form of parse_log: yields the fraction of the file consumed
 * every so often (for a progress bar), and returns the parsed log. */
function* parse_steps(bytes) {
	let header = parse_header(bytes);
	if (!SUPPORTED_VERSIONS.includes(header.version)) {
		throw new Error(`WinBolo log version ${header.version} is not supported (supported versions: ${SUPPORTED_VERSIONS.join(", ")})`);
	}
	let events = [];
	let snapshots = [];
	let warnings = [];
	let tick = 0;
	let p = header.offset;
	let finished = false;
	let next_yield = 0;
	/* The server writes its periodic snapshot partway through a tick: it
	 * flushes the events the tick has so far as a block of their own, then
	 * writes the snapshot, and the tick's own record follows it, so the
	 * tick is split across the two. The first record after such a
	 * snapshot (a no-events record, or from 2.1 a block holding the
	 * ServerTick) continues the flushed block's tick rather than taking a
	 * new one: a no-events count is trimmed by one, so a bare 1 takes no
	 * tick, and an event block shares the flushed block's tick. A shell in
	 * flight across a snapshot moves one step, not two, and the server's
	 * clocks agree. */
	let after_snapshot = false; /* the record before this one was a snapshot that a block preceded */
	let last_was_block = false; /* the last record that took a tick was an event block */
	let anchor = null; /* the last ServerTick: { server_tick, tick } */
	let idle = n => after_snapshot && n > 0 ? n - 1 : n;

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
			tick += idle(bytes[p + 1]);
			p += 2;
			after_snapshot = false;
			last_was_block = false;
		} else if (rec === REC_NOEVENTS_LONG) {
			if (p + 3 > bytes.length) break;
			/* little-endian, alone among the stream's counts */
			tick += idle(bytes[p + 1] | (bytes[p + 2] << 8));
			p += 3;
			after_snapshot = false;
			last_was_block = false;
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
			/* the block's extent and types first: which tick it takes
			 * depends on what it holds */
			let block = [];
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
				block.push({ type, payload: bytes.subarray(p + 3, p + 3 + len) });
				p += 3 + len;
			}
			let block_tick = after_snapshot ? tick - 1 : tick;
			/* WinBolo 2.1 follows a snapshot with a block holding only
			 * EntityMasks, the part of the world the snapshot has no room
			 * for. It is written straight after the snapshot, not by a game
			 * tick, so it takes none and leaves the snapshot's effect on the
			 * next record alone; it is dated with the tick the snapshot was
			 * written in, as that record will be. */
			if (block.length && block.every(x => x.type === EVENT.EntityMasks)) {
				for (let x of block) events.push(decode_event(x.type, x.payload, block_tick, warnings, header.version));
				continue;
			}
			/* From 2.1 the server's own tick, 100 a second, is in the block
			 * after every snapshot. Two ticks of it are one of the log's,
			 * so the previous one says which tick this block is; it settles
			 * the one case the rule above gets wrong, a block before the
			 * snapshot that was the previous tick's, written before the
			 * snapshot's tick had any events of its own. */
			let marker = block.find(x => x.type === EVENT.ServerTick && x.payload.length >= 4);
			let server_tick = marker ? be32(marker.payload, 0) : null;
			if (after_snapshot && server_tick !== null && anchor && server_tick > anchor.server_tick
				&& anchor.tick + (server_tick - anchor.server_tick) / 2 === tick) {
				block_tick = tick;
			}
			for (let x of block) events.push(decode_event(x.type, x.payload, block_tick, warnings, header.version));
			if (server_tick !== null) anchor = { server_tick, tick: block_tick };
			tick = block_tick + 1;
			after_snapshot = false;
			last_was_block = true;
		} else if (rec === REC_SNAPSHOT) {
			let s = parse_snapshot(bytes, p + 1, tick);
			s.event_index = events.length; /* first event at or after this snapshot */
			delete s.end;
			snapshots.push(s);
			p = s.end === undefined ? snapshot_end(bytes, p + 1) : s.end;
			/* a block before the snapshot was the flush of the snapshot's own
			 * tick; a no-events record before it counted only ticks before */
			after_snapshot = last_was_block;
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

/* ---------- attribution.trk ---------- */

/* The server's own record of who did what to whom, as John Morrison's
 * 2.03 format specification lays it out: a 1068-byte header (magic
 * "WBAT", a version, a truncated flag, the slot count, 16 slot identities
 * of 66 bytes, the record count), then records of a type byte, a uint32
 * tick and a fixed payload. Everything is little-endian, and the ticks
 * are the server's 10 ms steps counted from the start of the round: twice
 * the log's rate, and not from the log's tick 0 when there was a lobby. */
const ATTRIBUTION_HEADER = 1068;
const ATTRIBUTION_PAYLOAD = { 1: 9, 2: 7, 3: 7, 4: 4, 5: 4, 6: 4 };
const ATTRIBUTION_TYPES = { 1: "damage", 2: "kill", 3: "capture", 4: "lgm_lost", 5: "action", 6: "pickup" };
const DAMAGE_SOURCES = { 0: "unknown", 1: "shell", 2: "mine" };
const DAMAGE_TARGETS = { 0: "tank", 1: "pill", 2: "base" };
const CAPTURE_TARGETS = { 0: "pill", 1: "base" };
const CAPTURE_CLASSES = { 0: "neutral", 1: "enemy", 2: "ally" };
const ACTIONS = { 0: "farm", 1: "build", 2: "lay_mine", 3: "fire" };

function le16(b, p) { return b[p] | (b[p + 1] << 8); }
function le32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] * 0x1000000)) >>> 0; }

const ATTRIBUTION_DECODERS = {
	1: (b, r) => {
		r.source = DAMAGE_SOURCES[b[0]] || `source ${b[0]}`; r.target = DAMAGE_TARGETS[b[1]] || `target ${b[1]}`;
		r.target_index = b[2]; r.attacker = b[3]; r.amount = le16(b, 4); r.destroyed = b[6] !== 0; r.x = b[7]; r.y = b[8];
	},
	2: (b, r) => {
		r.killer = b[0]; r.killed = b[1]; r.death_cause = b[2]; r.carried_pills = b[3]; r.trees_wasted = b[4]; r.x = b[5]; r.y = b[6];
	},
	3: (b, r) => {
		r.target = CAPTURE_TARGETS[b[0]] || `target ${b[0]}`; r.target_index = b[1]; r.new_owner = b[2]; r.prev_owner = b[3];
		r.capture_class = CAPTURE_CLASSES[b[4]] || `class ${b[4]}`; r.x = b[5]; r.y = b[6];
	},
	4: (b, r) => { r.victim = b[0]; r.killer = b[1]; r.x = b[2]; r.y = b[3]; },
	5: (b, r) => { r.player = b[0]; r.action = ACTIONS[b[1]] || `action ${b[1]}`; r.x = b[2]; r.y = b[3]; },
	6: (b, r) => { r.picker = b[0]; r.pill = b[1]; r.x = b[2]; r.y = b[3]; },
};

function parse_attribution(bytes) {
	if (bytes.length < ATTRIBUTION_HEADER || text(bytes, 0, 4) !== "WBAT") throw new Error("not a WinBolo attribution file (no WBAT header)");
	let version = bytes[4];
	let truncated = bytes[5] !== 0;
	let slots = le16(bytes, 6);
	let count = le32(bytes, ATTRIBUTION_HEADER - 4);
	let players = [];
	for (let i = 0; i < MAX_TANKS; i++) {
		let q = 8 + i * 66;
		let name = "";
		for (let j = q + 2; j < q + 66 && bytes[j]; j++) name += String.fromCharCode(bytes[j]);
		players.push({ slot: i, bot: bytes[q] !== 0, team: bytes[q + 1], name });
	}
	let records = [];
	let p = ATTRIBUTION_HEADER;
	let warning = null;
	while (p + 5 <= bytes.length) {
		let type = bytes[p];
		let n = ATTRIBUTION_PAYLOAD[type];
		if (n === undefined) {
			/* records carry no length, so an unknown type ends the track */
			warning = `attribution record type ${type} at offset ${p} is unknown; ${records.length} of ${count} records read`;
			break;
		}
		if (p + 5 + n > bytes.length) break;
		let r = { tick: le32(bytes, p + 1), type, name: ATTRIBUTION_TYPES[type] };
		ATTRIBUTION_DECODERS[type](bytes.subarray(p + 5, p + 5 + n), r);
		records.push(r);
		p += 5 + n;
	}
	return { version, truncated, slots, count, players, records, warning, complete: !warning && records.length === count && p === bytes.length };
}

/* ---------- the archive ---------- */

/* WinBolo 2.1's scripts.json: what scripts a scripted round ran, and the
 * rules and regions it opened with, as a JSON object */
function parse_scripts(bytes) {
	let scripts = JSON.parse(new TextDecoder("utf-8").decode(bytes));
	if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) throw new Error("not a JSON object");
	return scripts;
}

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
			if (attribution.warning) log.warnings.push(`attribution.trk: ${attribution.warning}`);
		} catch (err) {
			log.warnings.push(`attribution.trk: ${err.message}`);
		}
	}
	let scripts = null;
	if (members["scripts.json"]) {
		try {
			scripts = parse_scripts(members["scripts.json"]);
		} catch (err) {
			log.warnings.push(`scripts.json: ${err.message}`);
		}
	}
	return { log, attribution, scripts, members: Object.keys(members), comment: entries.comment };
}

const WinBoloLog = {
	TICKS_PER_SECOND, MAP_SIZE, DEEP_SEA, NEUTRAL, MAX_TANKS, EVENT, EVENT_NAMES, GAME_TYPES, VOTE_KINDS,
	PING_KINDS, ENTITY_PILL, ENTITY_BASE, ENTITY_START, RULE_NAMES, SHELL_FRAME_BASE, LGM_HELICOPTER_FRAME,
	parse_header, parse_steps, parse_log, parse_snapshot, snapshot_grid, decode_runs,
	parse_attribution, parse_scripts, open_archive,
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = WinBoloLog;
} else {
	window.WinBoloLog = WinBoloLog;
}

})();
