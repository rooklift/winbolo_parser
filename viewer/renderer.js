"use strict";
/* WinBolo replay viewer renderer: canvas world view + playback transport.
 * View handling (zoom steps, wheel-to-cursor, pan, flat-colour underlay
 * with sprite overlay), the transport and the sidebar follow the Ancient
 * Bolo Log Viewer's renderer; the world it draws is WinBoloGame's. */

const { MAP_SIZE, DEEP_SEA } = BoloMap;
const TPS = WinBoloLog.TICKS_PER_SECOND;
const NEUTRAL = WinBoloGame.NEUTRAL;
const EFFECT_TICKS = WinBoloGame.EFFECT_TICKS;

const TERRAIN_COLORS = {
	0:  "#785e41",  /* building */
	1:  "#008c9c",  /* river */
	2:  "#003933",  /* swamp */
	3:  "#292911",  /* crater */
	4:  "#000000",  /* road */
	5:  "#045311",  /* forest */
	6:  "#303819",  /* rubble */
	7:  "#002806",  /* grass */
	8:  "#56422c",  /* shot building */
	9:  "#61848b",  /* boat on river */
	255: "#008a9e", /* deep sea */
};
const RGB = {};
for (let t = 0; t <= 9; t++) {
	let c = parseInt(TERRAIN_COLORS[t].slice(1), 16);
	RGB[t] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}
for (let t = 10; t <= 15; t++) RGB[t] = RGB[t - 8];
{
	let c = parseInt(TERRAIN_COLORS[255].slice(1), 16);
	RGB[255] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

/* Shapes mode uses the same allegiance language as the sprite art:
 * friendly green, hostile red, with nobody's bases (and nobody's pills
 * when that toggle is on) in their own amber. */
const FRIENDLY_COLOR = "#58d858";
const HOSTILE_COLOR = "#ff5d5d";
const NEUTRAL_COLOR = "#f0b429";

const OBJ_NATIVE_TILE = 16;
const LGM_ANIMATION = ["lgm_frame0", "lgm_frame1", "lgm_frame2"];
const PILL_MAX_ARMOUR = 15;
/* A burst's stage counts down from 8 (fresh) to 1 over 23 ticks; WinBolo's
 * own art is a spark that grows into a fireball by stage 5 and thins out
 * to sparks. The viewer keeps the Ancient Bolo viewer's look instead: a
 * ring spreading and fading over the same stages. Tank-hit debris and
 * landing wreckage fly at stage 8, so they show as the smallest rings. */
const EXPLOSION_STAGES = 8;

/* ---------- object sprites (sprites/objects/) ----------
 * WinBolo's own art, two-sided: "good" is the viewed player's team,
 * "evil" everyone else. Tank sprite indices match the log's 16-way
 * directions: 0 = north, clockwise. Pillbox indices are armour 0 (dead)
 * to 15 (fresh). On by default; Cmd/Ctrl+G switches to vector markers,
 * which also stand in below the sprite zoom threshold. */
let use_obj_sprites = true;
let use_lgm_sprites = true;
let use_big_shots = false;
let use_simple_terrain = false;
let use_neutral_pill_colour = true;
let coordinate_debug_enabled = false;
let pillbox_ids_enabled = false;
/* The wire shows chat alone (and the "game started" divider) unless the
 * event lines (joins, deaths, alliances, votes, server notices) are
 * switched on. The lobby's lines, before the start, can be hidden too;
 * the divider stays either way. */
let event_messages_enabled = false;
let pregame_messages_enabled = false;
let obj_imgs = new Map();

function load_obj_sprites() {
	let names = ["base_good", "base_evil", "base_neutral", "lgm_helicopter",
		"lgm_frame0", "lgm_frame1", "lgm_frame2"];
	for (let i = 0; i < 16; i++) {
		let n = String(i).padStart(2, "0");
		names.push(`tank_good_${n}`, `tank_evil_${n}`, `tank_goodboat_${n}`, `tank_evilboat_${n}`,
			`pillbox_good_${n}`, `pillbox_evil_${n}`, `pillbox_neutral_${n}`, `shell_${n}`);
	}
	for (let name of names) {
		let img = new Image();
		img.addEventListener("load", () => {
			obj_imgs.set(name, img);
			request_draw();
		});
		img.src = "sprites/objects/" + name + ".png";
	}
}

function obj_sprite(name) {
	return (use_obj_sprites && view.zoom >= BoloSprites.MIN_ZOOM) ? obj_imgs.get(name) : undefined;
}

/* The man's walking frame is the log's own (0-2); frame 3 is the parachute. */
function lgm_sprite(frame) {
	if (!use_lgm_sprites || view.zoom < BoloSprites.MIN_ZOOM) return undefined;
	return obj_imgs.get(LGM_ANIMATION[frame % LGM_ANIMATION.length]);
}

/* Object sprites are the same 16px art as the terrain, so at non-integer
 * device-pixel scales they need the same sharp-bilinear treatment as the
 * terrain atlas: nearest-prescale to the next integer multiple, cached per
 * image, then draw with smoothing on. */
let obj_scaled = new WeakMap(); /* img -> Map(factor -> prescaled canvas) */

function draw_obj_at_size(img, x, y, w, h) {
	let factor = BoloSprites.prescale_factor(view.zoom, devicePixelRatio);
	let src = img;
	if (factor > 1) {
		let per = obj_scaled.get(img);
		if (!per) obj_scaled.set(img, per = new Map());
		src = per.get(factor);
		if (!src) {
			src = document.createElement("canvas");
			src.width = img.width * factor;
			src.height = img.height * factor;
			let sctx = src.getContext("2d");
			sctx.imageSmoothingEnabled = false;
			sctx.drawImage(img, 0, 0, src.width, src.height);
			per.set(factor, src);
		}
	}
	ctx.imageSmoothingEnabled = factor > 1;
	ctx.drawImage(src, x, y, w, h);
	ctx.imageSmoothingEnabled = false;
}

function draw_obj(img, x, y) {
	draw_obj_at_size(img, x, y, view.zoom, view.zoom);
}

/* LGM and shell sprites are tightly cropped art rather than full 16x16
 * tiles. Draw each source pixel at the same scale as a pixel in the other
 * object art. */
function draw_cropped_obj(img, cx, cy) {
	let scale = view.zoom / OBJ_NATIVE_TILE;
	let w = img.width * scale, h = img.height * scale;
	draw_obj_at_size(img, cx - w / 2, cy - h / 2, w, h);
}

/* The team drawn as "good": the viewpoint player's, else the first present. */
function good_team() {
	if (viewpoint >= 0) return WinBoloGame.team_of(cur, viewpoint);
	for (let p = 0; p < 16; p++) {
		if (cur.players[p].in_use || cur.players[p].name !== null) return WinBoloGame.team_of(cur, p);
	}
	return 0;
}

function side_of(player) {
	return WinBoloGame.team_of(cur, player) === good_team() ? "good" : "evil";
}

/* ---------- state ---------- */
let game = null;         /* WinBoloGame.build() result */
let cur = null;          /* current world state */
let cursor = 0;          /* first unapplied event index */
let clock = 0;           /* current tick */
let playing = false;
let speed = 1;
let viewpoint = -1; /* player whose side draws as friendly; -1 = first player */
let player_locked = false;
let effect_lo = 0;       /* rolling window start into game.effects */
let chat_shown = 0;
let map_names_shown = 0;
let last_frame = null;
let last_viewpoint_html = null;

const ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
let view = { zoom: 3, ox: 0, oy: 0 };

/* ---------- DOM ---------- */
let canvas = document.getElementById("view");
let ctx = canvas.getContext("2d");
let play_btn = document.getElementById("playBtn");
let time_label = document.getElementById("timeLabel");
let seek_el = document.getElementById("seek");
let speed_el = document.getElementById("speed");
let viewpoint_el = document.getElementById("viewpoint");
let zoom_label = document.getElementById("zoomLabel");
let coordinate_debug_el = document.getElementById("coordinateDebug");
let coordinate_tile_el = document.getElementById("coordinateTile");
let coordinate_pixel_el = document.getElementById("coordinatePixel");
let drop_hint = document.getElementById("dropHint");
let drop_hint_text = document.getElementById("dropHintText");
let drop_hint_link = document.getElementById("dropHintLink");
let map_name_el = document.getElementById("mapName");
let game_meta_el = document.getElementById("gameMeta");
let version_meta_el = document.getElementById("versionMeta");
let game_type_meta_el = document.getElementById("gameTypeMeta");
let players_el = document.getElementById("players");
let chat_el = document.getElementById("chat");
let file_pick = document.getElementById("filePick");

/* One code base for the Electron app, the Tauri app and the web page: the
 * preload script gives Electron a window.api, tauri_api.js gives the Tauri
 * app one, and a browser has none. Without an application menu the web
 * page has no File → Open, and its toggle shortcuts are bare keys because
 * the browser owns Ctrl+D, Ctrl+T and friends. */
const WEB = !window.api;
const TOGGLE_CTRL = !WEB; /* whether a toggle shortcut wants Cmd/Ctrl held */

/* Electron's menu accelerators take Ctrl+O, the zoom keys and F11 before
 * the page sees them; the web page and the Tauri app (whose menu registers
 * no accelerators) handle those keys here instead. */
const PAGE_SHORTCUTS = WEB || !!window.api.page_shortcuts;

drop_hint_text.textContent = WEB
	? "Open a WinBolo replay (.wbv): drop it here, click to choose one, or press Ctrl+O."
	: "Open a WinBolo replay (.wbv): File → Open, drop it here, or click to choose one.";

/* The web page points at the repo; the apps ship with their own docs. The
 * whole hint is the open button, so a click on the link must not also
 * open the file picker. */
drop_hint_link.hidden = !WEB;
drop_hint_link.querySelector("a").addEventListener("click", e => e.stopPropagation());

/* Toggle shortcuts: Cmd/Ctrl+key in Electron (mirroring the menu's
 * accelerators), the bare key on the web. */
function toggle_key(e, code) {
	return e.code === code && (e.ctrlKey || e.metaKey) === TOGGLE_CTRL && !e.altKey;
}

/* Terrain as drawn: a base square counts as road for tile-selection, so
 * roads connect into bases instead of dead-ending. The base art covers
 * its own square. */
const ROAD = 4;
let display_grid_cache = null;
let display_grid_version = -1;

function display_grid() {
	if (display_grid_version !== cur.grid_version || !display_grid_cache) {
		display_grid_cache = cur.grid.slice();
		for (const b of cur.bases) {
			display_grid_cache[b.y * MAP_SIZE + b.x] = ROAD;
		}
		display_grid_version = cur.grid_version;
	}
	return display_grid_cache;
}

/* offscreen 1px-per-tile terrain image */
let off = document.createElement("canvas");
off.width = off.height = MAP_SIZE;
let off_ctx = off.getContext("2d");
let off_img = off_ctx.createImageData(MAP_SIZE, MAP_SIZE);
let off_version = -1;

function rebuild_offscreen() {
	let d = off_img.data;
	let grid = display_grid();
	for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
		let [r, g, b] = RGB[grid[i]] || RGB[255];
		d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
	}
	off_ctx.putImageData(off_img, 0, 0);
	off_version = cur.grid_version;
}

/* ---------- view helpers ---------- */
function css_size() {
	return { w: canvas.clientWidth, h: canvas.clientHeight };
}
function tile_to_screen_x(tx) { return (tx - view.ox) * view.zoom; }
function tile_to_screen_y(ty) { return (ty - view.oy) * view.zoom; }

let hover_point = null;
let pointer_buttons = 0;

function hover_point_from_event(e) {
	if (e.offsetX < 0 || e.offsetY < 0 ||
		e.offsetX >= canvas.clientWidth || e.offsetY >= canvas.clientHeight) return null;
	return { x: e.offsetX, y: e.offsetY };
}

function update_coordinate_debug() {
	if (!coordinate_debug_enabled || !cur || !hover_point || pointer_buttons !== 0) {
		coordinate_debug_el.hidden = true;
		return;
	}
	let pixel_x = Math.floor((view.ox + hover_point.x / view.zoom) * OBJ_NATIVE_TILE);
	let pixel_y = Math.floor((view.oy + hover_point.y / view.zoom) * OBJ_NATIVE_TILE);
	let max_pixel = MAP_SIZE * OBJ_NATIVE_TILE;
	if (pixel_x < 0 || pixel_y < 0 || pixel_x >= max_pixel || pixel_y >= max_pixel) {
		coordinate_debug_el.hidden = true;
		return;
	}
	coordinate_tile_el.textContent = `${Math.floor(pixel_x / OBJ_NATIVE_TILE)}, ${Math.floor(pixel_y / OBJ_NATIVE_TILE)}`;
	coordinate_pixel_el.textContent = `${pixel_x}, ${pixel_y}`;
	coordinate_debug_el.hidden = false;
}

function tank_world(p) {
	let t = cur.players[p].tank;
	if (!t.in_world) return null;
	return { x: WinBoloGame.world_x(t), y: WinBoloGame.world_y(t) };
}

function centre_locked_player() {
	if (!player_locked || !game || !cur || viewpoint < 0) return false;
	let position = tank_world(viewpoint);
	if (!position) return false;
	let { w, h } = css_size();
	view.ox = position.x - w / (2 * view.zoom);
	view.oy = position.y - h / (2 * view.zoom);
	return true;
}

function clamp_view() {
	let { w, h } = css_size();
	let tw = w / view.zoom, th = h / view.zoom;
	let margin = 16;
	view.ox = Math.max(-tw + margin, Math.min(MAP_SIZE - margin, view.ox));
	view.oy = Math.max(-th + margin, Math.min(MAP_SIZE - margin, view.oy));
}

function zoom_to(z, mx, my) {
	if (z === view.zoom) return;
	let { w, h } = css_size();
	if (mx === undefined) { mx = w / 2; my = h / 2; }
	let tx = view.ox + mx / view.zoom;
	let ty = view.oy + my / view.zoom;
	view.zoom = z;
	view.ox = tx - mx / z;
	view.oy = ty - my / z;
	clamp_view();
	zoom_label.textContent = `zoom ${z}×`;
	request_draw();
}
function zoom_step(delta) {
	let idx = ZOOMS.indexOf(view.zoom);
	zoom_to(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, idx + delta))]);
}
function zoom_fit() {
	let { w, h } = css_size();
	let z = ZOOMS[0];
	for (let c of ZOOMS) if (c * MAP_SIZE <= Math.min(w, h)) z = c;
	view.zoom = z;
	view.ox = 128 - w / (2 * z);
	view.oy = 128 - h / (2 * z);
	zoom_label.textContent = `zoom ${z}×`;
	request_draw();
}

/* Bounding box of the played area: the land of the map as it ends up
 * (a server log's first snapshot is often an empty map, before the game
 * was set up), falling back to the current state's land. */
function action_bounds() {
	if (!cur) return null;
	return game.bounds || WinBoloGame.land_bounds(cur.grid);
}

/* Fit the view to the played area rather than the whole 256×256 sea. */
function zoom_to_action() {
	let b = action_bounds();
	if (!b) return zoom_fit();
	let { w, h } = css_size();
	let spanx = b.maxx - b.minx + 8, spany = b.maxy - b.miny + 8;
	let z = ZOOMS[0];
	for (let c of ZOOMS) if (c * spanx <= w && c * spany <= h) z = c;
	view.zoom = z;
	view.ox = (b.minx + b.maxx + 1) / 2 - w / (2 * z);
	view.oy = (b.miny + b.maxy + 1) / 2 - h / (2 * z);
	zoom_label.textContent = `zoom ${z}×`;
	request_draw();
}

/* Bounding box of the map's start (spawn) points, or null if it has none. */
function start_bounds() {
	let starts = cur && cur.starts.length ? cur.starts : (game && game.final.starts);
	if (!starts || !starts.length) return null;
	let minx = MAP_SIZE, miny = MAP_SIZE, maxx = 0, maxy = 0;
	for (let st of starts) {
		if (st.x < minx) minx = st.x;
		if (st.x > maxx) maxx = st.x;
		if (st.y < miny) miny = st.y;
		if (st.y > maxy) maxy = st.y;
	}
	return { minx, miny, maxx, maxy };
}

/* Centre the view at the current zoom on the middle of the start points'
 * bounding box, where play happens; the land box when the map has no
 * starts, the map's middle when it's all sea. Releases the player lock,
 * as panning does. */
function centre_map() {
	let b = start_bounds() || action_bounds();
	let cx = b ? (b.minx + b.maxx + 1) / 2 : MAP_SIZE / 2;
	let cy = b ? (b.miny + b.maxy + 1) / 2 : MAP_SIZE / 2;
	let { w, h } = css_size();
	view.ox = cx - w / (2 * view.zoom);
	view.oy = cy - h / (2 * view.zoom);
	if (player_locked) {
		player_locked = false;
		update_lock_indicator();
	}
	request_draw();
}

/* ---------- playback ---------- */
function set_clock(tick, hard) {
	if (!game) return;
	tick = Math.max(game.t0, Math.min(game.t1, tick));
	if (hard || tick < clock) {
		/* backwards (or explicit reset): restore from the nearest snapshot */
		let r = WinBoloGame.state_at(game, tick);
		cur = r.state;
		cursor = r.index;
		off_version = -1;
		display_grid_version = -1;
		display_grid_cache = null;
		effect_lo = lower_bound_effect(tick - EFFECT_TICKS);
		rebuild_chat(tick);
	} else {
		cursor = WinBoloGame.advance(game, cur, cursor, tick);
	}
	clock = tick;
	update_transport();
	request_draw();
}

function lower_bound_effect(t) {
	let lo = 0, hi = game.effects.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (game.effects[mid].tick < t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function frame(ts) {
	if (playing && game) {
		if (last_frame !== null) {
			let dt = Math.min(0.25, (ts - last_frame) / 1000);
			set_clock(clock + dt * TPS * speed);
			if (clock >= game.t1) set_playing(false);
		}
		last_frame = ts;
		request_draw();
		requestAnimationFrame(frame);
	} else {
		last_frame = null;
	}
}

function set_playing(p) {
	if (!game) p = false;
	if (p === playing) return;
	playing = p;
	play_btn.textContent = playing ? "❚❚" : "▶";
	if (playing) {
		if (clock >= game.t1) set_clock(game.t0, true);
		last_frame = null;
		requestAnimationFrame(frame);
	}
}

function step_change(direction) {
	if (!game) return;
	set_playing(false);
	let tick = WinBoloGame.adjacent_change_tick(game, clock, direction);
	set_clock(tick, direction < 0);
}

function go_to_boundary(at_end) {
	if (!game) return;
	set_playing(false);
	set_clock(at_end ? game.t1 : game.t0, !at_end);
}

/* m:ss from the game start, or h:mm:ss past an hour. A tick before the
 * start (lobby chat on the wire) is negative, counted up to the second
 * it falls in, so the last tick before the start reads -0:01. */
function fmt_time(ticks) {
	let d = ticks - game.t0;
	let s = d < 0 ? Math.ceil(-d / TPS) : Math.floor(d / TPS);
	let h = Math.floor(s / 3600);
	let m = Math.floor(s / 60) % 60;
	let text = h ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
	return d < 0 ? "-" + text : text;
}

function update_transport() {
	if (!game) return;
	time_label.textContent = `${fmt_time(clock)} / ${fmt_time(game.t1)}`;
	game_meta_el.textContent = `${cursor.toLocaleString()} / ${game.events.length.toLocaleString()} events`;
	let span = Math.max(1, game.t1 - game.t0);
	seek_el.value = Math.round(((clock - game.t0) / span) * 1000);
	update_map_name();
	update_viewpoint_options();
	update_players();
	update_chat();
}

/* The map name: the header's, until a server message says the map was
 * changed (the server can switch maps in the lobby; the log records the
 * announcement, not a map-name field). */
function update_map_name() {
	while (map_names_shown < game.map_names.length && game.map_names[map_names_shown].tick <= clock) map_names_shown++;
	let name = map_names_shown > 0 ? game.map_names[map_names_shown - 1].name : game.header.map_name;
	if (map_name_el.textContent !== name) map_name_el.textContent = name;
}

/* ---------- sidebar ---------- */

/* Names belong to player slots and can change when a vacated slot is
 * reused. Follow the state at the playback clock. Names deliberately
 * survive quits, so a departed player remains selectable until another
 * player takes their slot. */
function update_viewpoint_options() {
	let html = "";
	let first = -1;
	for (let p = 0; p < 16; p++) {
		if (!cur.players[p].name) continue;
		if (first < 0) first = p;
		html += `<option value="${p}">${esc(cur.players[p].name)}</option>`;
	}
	if (last_viewpoint_html === html) return;

	last_viewpoint_html = html;
	viewpoint_el.innerHTML = html;
	if (viewpoint < 0 || !cur.players[viewpoint].name) viewpoint = first;
	if (viewpoint >= 0) viewpoint_el.value = String(viewpoint);
}

/* Name colours for the players panel and message wire: team-indexed like
 * the map colours, but with no reds or greens, which the viewer already
 * uses to mean friendly/enemy. */
const NAME_COLORS = [
	"#4da3ff", "#f0b429", "#c77dff", "#4dd8d8",
	"#ff7ab8", "#ff9d3b", "#7d8bff", "#e066e0",
	"#8ad8ff", "#e0b08a", "#d8d84d", "#b0c4d8",
	"#f0e68c", "#c8a2c8", "#66c8e0", "#e8c468",
];

function player_color(p) {
	return NAME_COLORS[WinBoloGame.team_of(cur, p)];
}

function update_players() {
	let html = "";
	for (let p = 0; p < 16; p++) {
		let pl = cur.players[p];
		if (pl.name === null && !pl.in_use) continue;
		let cls = pl.quit ? " gone" : "";
		html += `<div class="player${cls}">` +
			`<span class="chip" style="background:${player_color(p)}"></span>` +
			`<span>${esc(pl.name || `player ${p}`)}</span> <span class="host">${esc(pl.location || "")}</span></div>`;
	}
	/* compare against our own last string, not innerHTML: the serializer
	 * re-encodes entities so innerHTML never matches for some names */
	if (last_players_html !== html) { last_players_html = html; players_el.innerHTML = html; }
}
let last_players_html = null;

/* HTML-escape for text content. Quotes are NOT escaped — never interpolate
 * the result into an attribute value. */
function esc(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* Stray control bytes in names or chat, shown as ␀ rather than dropped. */
function pretty(s) {
	return String(s).replace(/[\x00-\x1f\x7f]/g, "␀");
}

/* One chat line as styled segments. A segment with `who` set is the
 * speaker's coloured name; everything else inherits the line style. */
function chat_line_parts(m) {
	let color = NAME_COLORS[m.team !== undefined ? m.team : 0];
	let who = pretty(m.name || "");
	let sys = text => ({ tick: m.tick, sys: true, segments: [{ text }] });
	switch (m.kind) {
		case "server": return sys(`⚙ ${pretty(m.text)}`);
		case "join": return sys(`⚑ ${pretty(m.text)}${m.country ? ` (${m.country})` : ""}`);
		case "quit": return sys(`✝ ${who} left the game`);
		case "rejoin": return sys(`↻ ${who} rejoined`);
		case "rename": return sys(`⇄ ${pretty(m.from || "")} is now ${pretty(m.text)}`);
		case "kill": return sys(`✸ ${pretty(m.killer_name)} killed ${who}`);
		case "pill_kill": return sys(`✸ a pillbox killed ${who}`);
		case "mine_kill": return sys(`✸ a mine killed ${who}`);
		case "drowned": return sys(`✸ ${who} drowned`);
		case "boat_sunk": return sys(m.sinker_name ? `✸ ${pretty(m.sinker_name)} sank ${who}` : `✸ ${who} was sunk`);
		case "died": return sys(`✸ ${who} died`);
		case "lost_man": return sys(`✝ ${who} lost his builder`);
		case "ally_request": return sys(`${who} asked ${pretty(m.other_name)} for an alliance`);
		case "ally_accept": return sys(`${who} allied with ${pretty(m.other_name)}`);
		case "ally_leave": return sys(`${who} left the alliance`);
		case "save_map": return sys(`${who} saved the map`);
		case "ready": return sys(`${who} is ready`);
		case "unready": return sys(`${who} is not ready`);
		case "countdown_cancel": return sys("⏱ countdown cancelled");
		case "spectator_join": return sys(`◌ ${pretty(m.text)} is watching${m.country ? ` (${m.country})` : ""}`);
		case "spectator_quit": return sys(`◌ ${pretty(m.text)} stopped watching`);
		case "countdown": return sys("⏱ countdown");
		case "vote_called": return sys(`☐ ${who} called a vote to ${m.what}`);
		case "vote_cast": return sys(`${m.vote ? "☑" : "☒"} ${who} voted ${m.vote ? "yes" : "no"}`);
		case "vote_result": return sys(`⚐ vote to ${m.what} ${m.passed ? "passed" : "failed"}`);
		case "game_start": return sys("⚐ game started");
	}
	let scope = m.to ? " (to some)" : "";
	return { tick: m.tick, sys: false, segments: [
		{ text: who, who: true, color },
		{ text: `${scope}: ${pretty(m.text)}` },
	] };
}

function chat_line(m) {
	let parts = chat_line_parts(m);
	let inner = parts.segments.map(s => s.who
		? `<span class="who" style="color:${s.color}">${esc(s.text)}</span>`
		: esc(s.text)).join("");
	return `<div class="msg${parts.sys ? " sys" : ""}">` +
		`<span class="t">${fmt_time(parts.tick)}</span> ${inner}</div>`;
}

function rebuild_chat(tick) {
	chat_shown = 0;
	map_names_shown = 0;
	chat_el.innerHTML = "";
	update_chat(tick);
}

function update_chat(tick = clock) {
	let added = false;
	while (chat_shown < game.chat.length && game.chat[chat_shown].tick <= tick) {
		let m = game.chat[chat_shown++];
		/* the "game started" line is the divider between the lobby's chat
		 * and the game's, so it shows whatever else is hidden */
		if (m.kind !== "game_start") {
			if (!event_messages_enabled && m.kind !== "say") continue;
			if (!pregame_messages_enabled && m.tick < game.t0) continue;
		}
		chat_el.insertAdjacentHTML("beforeend", chat_line(m));
		added = true;
	}
	if (added) chat_el.scrollTop = chat_el.scrollHeight;
}

/* ---------- drawing ---------- */
let draw_queued = false;
function request_draw() {
	if (loading) return; /* the loading bar owns the canvas until the load ends */
	if (draw_queued) return;
	draw_queued = true;
	requestAnimationFrame(() => {
		draw_queued = false;
		draw();
	});
}

/* Keep the view origin on whole device pixels. Centring on a tank (or a
 * resize, or a fractional pointer delta) can leave it a fraction off,
 * and pixel art drawn at a fractional offset resamples unevenly: doubled
 * and dropped columns. Panning moves by whole pixels, so once snapped
 * it stays snapped. */
function snap_view() {
	let unit = view.zoom * devicePixelRatio;
	view.ox = Math.round(view.ox * unit) / unit;
	view.oy = Math.round(view.oy * unit) / unit;
}

function draw() {
	if (!cur) return;
	centre_locked_player();
	snap_view();
	let { w, h } = css_size();
	let z = view.zoom;

	if (off_version !== cur.grid_version) rebuild_offscreen();

	let dpr = devicePixelRatio;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.fillStyle = "#0a0e16";
	ctx.fillRect(0, 0, w, h);
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(off, view.ox, view.oy, w / z, h / z, 0, 0, w, h);

	/* Mines are hidden with the other fine detail below the sprite threshold.
	 * Above it, their atlas sprites draw even when simple terrain is forced. */
	if (z >= BoloSprites.MIN_ZOOM) {
		BoloSprites.draw_view(ctx, display_grid(), view, w, h, !use_simple_terrain, dpr);
	}

	/* WinBolo's order: pills and bases are part of the terrain, shells and
	 * explosions go over them, then the tanks, then the men */
	draw_bases();
	draw_pills(true);
	draw_pills(false);
	draw_pillbox_labels();
	draw_shells();
	draw_falling_shells();
	draw_effects();
	draw_men(false);
	draw_tanks();
	draw_men(true);
	update_coordinate_debug();
}

function side_color(player) {
	return side_of(player) === "good" ? FRIENDLY_COLOR : HOSTILE_COLOR;
}

/* Which side a pill or base draws on for the viewpoint's team: nobody's
 * are hostile to everyone. */
function item_side(item, good) {
	if (item.owner === NEUTRAL) return "evil";
	return WinBoloGame.team_of(cur, item.owner) === good ? "good" : "evil";
}

function draw_bases() {
	let z = view.zoom;
	let r = Math.max(2.5, z * 0.42);
	let good = good_team();
	for (const b of cur.bases) {
		let side = b.owner === NEUTRAL ? "neutral" : item_side(b, good);
		let img = obj_sprite(`base_${side}`);
		if (img) {
			draw_obj(img, tile_to_screen_x(b.x), tile_to_screen_y(b.y));
			continue;
		}
		let cx = tile_to_screen_x(b.x) + z / 2, cy = tile_to_screen_y(b.y) + z / 2;
		ctx.fillStyle = side === "neutral" ? NEUTRAL_COLOR : side === "good" ? FRIENDLY_COLOR : HOSTILE_COLOR;
		ctx.strokeStyle = "rgba(0,0,0,0.65)";
		ctx.lineWidth = 1.5;
		ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
		ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
	}
}

/* As item_side, but with the neutral pill colour on, nobody's pills draw
 * as "neutral" rather than as hostile. */
function pill_colour_side(p, good) {
	if (use_neutral_pill_colour && p.owner === NEUTRAL) return "neutral";
	return item_side(p, good);
}

function draw_pills(dead) {
	let z = view.zoom;
	let r = Math.max(2, z * 0.36);
	let good = good_team();
	for (let p of cur.pills) {
		if (p.in_tank || (p.armour === 0) !== dead) continue;
		let cx = tile_to_screen_x(p.x) + z / 2;
		let cy = tile_to_screen_y(p.y) + z / 2;
		let side = pill_colour_side(p, good);
		let img = obj_sprite(`pillbox_${side}_${String(Math.min(PILL_MAX_ARMOUR, p.armour)).padStart(2, "0")}`);
		if (img) {
			draw_obj(img, tile_to_screen_x(p.x), tile_to_screen_y(p.y));
			continue;
		}
		ctx.fillStyle = dead ? "#555c6a"
			: side === "good" ? FRIENDLY_COLOR : side === "neutral" ? NEUTRAL_COLOR : HOSTILE_COLOR;
		ctx.strokeStyle = "rgba(0,0,0,0.65)";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		if (!dead) {
			/* damage pocks: dark dots at fixed pseudo-random spots, accreting
			 * in order as the pill takes hits */
			let pocks = Math.min(PILL_POCKS.length, PILL_MAX_ARMOUR - p.armour);
			if (pocks > 0) {
				ctx.fillStyle = "rgba(0,0,0,0.6)";
				let pr = Math.max(0.75, z * 0.055);
				for (let i = 0; i < pocks; i++) {
					ctx.beginPath();
					ctx.arc(cx + PILL_POCKS[i][0] * r * 0.72, cy + PILL_POCKS[i][1] * r * 0.72, pr, 0, Math.PI * 2);
					ctx.fill();
				}
			}
		}
	}
}

function draw_pillbox_labels() {
	if (!pillbox_ids_enabled) return;
	let z = view.zoom;
	let r = Math.max(3, z * 0.45);
	for (let pillbox = 0; pillbox < cur.pills.length; pillbox++) {
		let p = cur.pills[pillbox];
		if (p.in_tank) continue;
		let cx = tile_to_screen_x(p.x) + z / 2;
		let cy = tile_to_screen_y(p.y) + z / 2;
		draw_object_label(`#${pillbox}`, cx, cy, r);
	}
}

/* 14 well-spread fixed points in the unit circle, so pillbox damage looks
 * the same on every pill, every frame. */
const PILL_POCKS = [
	[-0.040, -0.649], [0.700, 0.023], [0.259, 0.954], [-0.203, 0.711],
	[0.682, -0.528], [-0.432, 0.193], [-0.470, -0.399], [-0.987, -0.115],
	[0.141, -0.019], [0.214, 0.470], [0.797, 0.559], [-0.898, 0.410],
	[-0.478, -0.873], [0.353, -0.903],
];

function draw_tanks() {
	let z = view.zoom;
	let r = Math.max(3, z * 0.45);
	for (let p = 0; p < 16; p++) {
		let pl = cur.players[p];
		let t = pl.tank;
		if (!t.in_world || pl.quit) continue;
		let cx = tile_to_screen_x(WinBoloGame.world_x(t));
		let cy = tile_to_screen_y(WinBoloGame.world_y(t));
		/* sprite indices match the log: 0 = north, clockwise (4 = east) */
		let img = obj_sprite(`tank_${side_of(p)}${t.on_boat ? "boat" : ""}_${String(t.dir).padStart(2, "0")}`);
		if (img) {
			draw_obj(img, cx - z / 2, cy - z / 2);
			draw_tank_label(p, cx, cy, r);
			continue;
		}
		ctx.save();
		ctx.translate(cx, cy);
		ctx.rotate((t.dir / 16) * Math.PI * 2); /* 0 = north, clockwise */
		ctx.fillStyle = side_color(p);
		ctx.strokeStyle = "rgba(0,0,0,0.7)";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(0, -r * 1.2);
		ctx.lineTo(r * 0.85, r);
		ctx.lineTo(-r * 0.85, r);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		ctx.restore();
		draw_tank_label(p, cx, cy, r);
	}
}

function draw_tank_label(p, cx, cy, r) {
	let name = pretty(cur.players[p].name || `p${p}`);
	draw_object_label(name, cx, cy, r);
}

function draw_object_label(label, cx, cy, r) {
	let z = view.zoom;
	if (z < 8) return;
	ctx.font = `${Math.max(9, z * 0.55)}px system-ui`;
	ctx.textAlign = "center";
	ctx.textBaseline = "bottom";
	ctx.fillStyle = "rgba(0,0,0,0.7)";
	ctx.fillText(label, cx + 1, cy - r - 2);
	ctx.fillStyle = "#fff";
	ctx.fillText(label, cx, cy - r - 3);
}

/* Men on foot draw beneath tanks; parachuting men are airborne, so they are
 * drawn in a second pass above every other sprite. The log restates each
 * man every tick he is out of his tank, so a state older than the clock
 * shows none. */
function draw_men(parachuting) {
	let z = view.zoom;
	if (!WinBoloGame.restated(cur, clock)) return;
	for (let p = 0; p < 16; p++) {
		let pl = cur.players[p];
		let m = pl.lgm;
		if (!m.out || pl.quit) continue;
		let parachute = m.frame === WinBoloLog.LGM_HELICOPTER_FRAME;
		if (parachute !== parachuting) continue;
		let cx = tile_to_screen_x(WinBoloGame.world_x(m));
		let cy = tile_to_screen_y(WinBoloGame.world_y(m));
		if (parachute) {
			let img = obj_sprite("lgm_helicopter");
			if (img) {
				draw_obj(img, cx - z / 2, cy - z / 2);
				continue;
			}
			ctx.strokeStyle = "#fff";
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.arc(cx, cy - z * 0.15, Math.max(2.5, z * 0.3), Math.PI, 0);
			ctx.stroke();
		}
		let img = lgm_sprite(m.frame);
		if (img) {
			draw_cropped_obj(img, cx, cy);
			continue;
		}
		/* men colour by allegiance to the viewpoint: friendly green, enemy red */
		ctx.fillStyle = "#fff";
		ctx.strokeStyle = side_color(p);
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.arc(cx, cy, Math.max(1.5, z * 0.14), 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
	}
}

/* Shells and explosions: the log restates every one each tick, position
 * and all, so there is nothing to interpolate. A shell's position is its
 * centre; an explosion's is the top-left corner of the 16-pixel tile
 * WinBolo draws for it (a shell's burst is logged at the shell's position
 * less half a tile, and the client draws every explosion frame that way),
 * so its centre sits half a tile down and right of the logged point. */
const EXPLOSION_OFFSET = 0.5;
function draw_shells() {
	let z = view.zoom;
	if (!WinBoloGame.restated(cur, clock)) return;
	for (let sh of cur.shells) {
		/* a shell that fell at the end of its range gets the splash and
		 * the fall segment in place of the log's fireball */
		if (sh.cause === "fall") continue;
		let cx = tile_to_screen_x(WinBoloGame.world_x(sh));
		let cy = tile_to_screen_y(WinBoloGame.world_y(sh));
		if (sh.explosion !== undefined) {
			/* the logged point is the corner of the tile the game draws */
			cx += EXPLOSION_OFFSET * z;
			cy += EXPLOSION_OFFSET * z;
			let age = (EXPLOSION_STAGES - sh.explosion) / (EXPLOSION_STAGES - 1); /* 0 fresh .. 1 spent */
			ctx.strokeStyle = `rgba(255,${180 - age * 120 | 0},60,${1 - age * 0.85})`;
			ctx.lineWidth = Math.max(1, z * 0.12);
			ctx.beginPath();
			ctx.arc(cx, cy, (0.2 + age * 0.5) * z, 0, Math.PI * 2);
			ctx.stroke();
			continue;
		}
		draw_shell(cx, cy, sh.dir, sh.owner);
	}
}

/* One shell in flight: the direction sprite, or a mark in its owner's
 * side colour (pillbox shells stay white). */
function draw_shell(cx, cy, dir, owner) {
	let z = view.zoom;
	let img = !use_big_shots ? obj_sprite(`shell_${String(dir).padStart(2, "0")}`) : undefined;
	if (img) {
		draw_cropped_obj(img, cx, cy);
		return;
	}
	ctx.fillStyle = typeof owner === "number" ? side_color(owner) : (use_big_shots ? "#ffe678" : "#fff");
	if (!use_big_shots) {
		let small_size = Math.max(1, z / 8);
		ctx.fillRect(cx - small_size / 2, cy - small_size / 2, small_size, small_size);
		return;
	}
	ctx.beginPath();
	ctx.arc(cx, cy, Math.max(1, z * 0.12), 0, Math.PI * 2);
	ctx.fill();
}

/* A landing shell flies on from its last logged position to its splash. */
function draw_falling_shells() {
	if (!game) return;
	for (let s of WinBoloGame.fall_positions_at(game, clock)) {
		draw_shell(tile_to_screen_x(s.x), tile_to_screen_y(s.y), s.dir, s.owner);
	}
}

function draw_effects() {
	if (!game) return;
	let z = view.zoom;
	while (effect_lo < game.effects.length && game.effects[effect_lo].tick < clock - EFFECT_TICKS) effect_lo++;
	for (let i = effect_lo; i < game.effects.length && game.effects[i].tick <= clock; i++) {
		let e = game.effects[i];
		let age = (clock - e.tick) / EFFECT_TICKS; /* 0..1 */
		let cx = tile_to_screen_x(e.x);
		let cy = tile_to_screen_y(e.y);
		switch (e.type) {
			case "tank_death": {
				ctx.strokeStyle = `rgba(255,120,40,${1 - age})`;
				ctx.lineWidth = Math.max(1.5, z * 0.2);
				ctx.beginPath();
				ctx.arc(cx, cy, (0.4 + age * 1.6) * z, 0, Math.PI * 2);
				ctx.stroke();
				break;
			}
			case "SoundHitTank": case "SoundHitTree": case "SoundHitWall": {
				ctx.strokeStyle = `rgba(255,${180 - age * 120 | 0},60,${1 - age})`;
				ctx.lineWidth = Math.max(1, z * 0.12);
				ctx.beginPath();
				ctx.arc(cx + z / 2, cy + z / 2, (0.2 + age * 0.5) * z, 0, Math.PI * 2);
				ctx.stroke();
				break;
			}
			case "SoundExplosion": case "SoundBigExplosion": case "SoundMineExplode": {
				ctx.strokeStyle = `rgba(255,120,40,${1 - age})`;
				ctx.lineWidth = Math.max(1.5, z * 0.2);
				ctx.beginPath();
				ctx.arc(cx + z / 2, cy + z / 2, (0.4 + age * (e.type === "SoundBigExplosion" ? 1.6 : 0.9)) * z, 0, Math.PI * 2);
				ctx.stroke();
				break;
			}
			case "splash": {
				/* a shell landing at the end of its range: the Ancient Bolo
				 * viewer's ripple, a thin pale ring spreading and fading */
				ctx.strokeStyle = `rgba(150,200,255,${1 - age})`;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.arc(cx, cy, (0.15 + age * 0.3) * z, 0, Math.PI * 2);
				ctx.stroke();
				break;
			}
			case "lgm_death": case "SoundManDie": {
				/* the man dies in a burst of streaks flying out from his
				 * square: each streak's head races outward and its tail
				 * detaches from the centre behind it, the whole fading */
				let burst = lgm_death_burst(e);
				let head = 1 - (1 - age) * (1 - age);
				let tail = age * age;
				if (e.type === "SoundManDie") { cx += z / 2; cy += z / 2; }
				ctx.globalAlpha = 1 - age;
				ctx.strokeStyle = e.player !== undefined ? side_color(e.player) : "#fff";
				ctx.lineWidth = Math.max(1, z * 0.1);
				ctx.lineCap = "round";
				ctx.beginPath();
				for (let line of burst) {
					let r0 = line.length * tail * z;
					let r1 = line.length * head * z;
					ctx.moveTo(cx + line.dx * r0, cy + line.dy * r0);
					ctx.lineTo(cx + line.dx * r1, cy + line.dy * r1);
				}
				ctx.stroke();
				ctx.lineCap = "butt";
				ctx.globalAlpha = 1;
				break;
			}
		}
	}
}

const LGM_DEATH_LINES = 10;

/* The streaks of a death burst, fixed for the life of the effect so they
 * hold still from frame to frame, from a small generator seeded by the
 * event's time and square. Cached on the effect. */
function lgm_death_burst(e) {
	if (e.burst) return e.burst;
	let seed = (e.tick * 73856093) ^ (Math.floor(e.x) * 19349663) ^ (Math.floor(e.y) * 83492791);
	let next = () => {  /* mulberry32 */
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	let burst = [];
	for (let i = 0; i < LGM_DEATH_LINES; i++) {
		let angle = (i + next() * 0.8) * Math.PI * 2 / LGM_DEATH_LINES;
		burst.push({ dx: Math.cos(angle), dy: Math.sin(angle), length: 0.5 + next() * 1.0 });
	}
	e.burst = burst;
	return burst;
}

/* ---------- loading ---------- */
const MAX_LOG_BYTES = 256 << 20;

const LOADING_REPAINT_MS = 100;
let loading_painted_at = -Infinity;
/* Loads yield to the event loop, so a replay dropped during a load starts
 * a second one: each load takes a generation, and an older load abandons
 * itself at its next yield once a newer one has begun. */
let load_generation = 0;
const SUPERSEDED = Symbol("superseded");
let before_load = null;
let loading = false;

async function loading_progress(label, progress) {
	if (performance.now() - loading_painted_at < LOADING_REPAINT_MS) return;
	await loading_stage(label, progress);
	loading_painted_at = performance.now();
}

/* Paint the loading bar and resolve once it has reached the screen. */
function loading_stage(label, progress) {
	return new Promise(resolve => requestAnimationFrame(() => {
		let { w, h } = css_size();
		let bar_width = Math.min(600, w * 0.75), bar_height = 56;
		let x = (w - bar_width) / 2, y = (h - bar_height) / 2;
		ctx.save();
		ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
		ctx.fillStyle = "#161b26";
		ctx.fillRect(x, y, bar_width, bar_height);
		ctx.fillStyle = "#006644";
		ctx.fillRect(x, y, bar_width * progress, bar_height);
		ctx.strokeStyle = "#000000";
		ctx.lineWidth = 4;
		ctx.strokeRect(x, y, bar_width, bar_height);
		ctx.fillStyle = "#ffffff";
		ctx.font = "600 17px system-ui, sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(label, w / 2, h / 2);
		ctx.restore();
		setTimeout(resolve, 0);
	}));
}

/* Map names announced by the server, lobby included, for the sidebar. */
function announced_map_names(server_messages) {
	let names = [];
	for (let m of server_messages) {
		let match = /^Map changed to (.+)$/.exec(m.text);
		if (match) names.push({ tick: m.tick, name: match[1] });
	}
	return names;
}

async function load_log(bytes, name) {
	/* Parse fully before touching viewer state, so a malformed file leaves
	 * any currently loaded replay running. */
	if (!loading) {
		loading = true;
		before_load = {
			playing,
			drop_hint: !drop_hint.classList.contains("hidden"),
		};
	}
	let new_game, archive;
	let generation = ++load_generation;
	let progress = async (label, fraction) => {
		await loading_progress(label, fraction);
		if (generation !== load_generation) throw SUPERSEDED;
	};
	set_playing(false);
	drop_hint.classList.add("hidden");
	try {
		loading_painted_at = -Infinity;
		await loading_stage("Reading replay…", 0);
		if (bytes.length > MAX_LOG_BYTES) {
			throw new Error(`${bytes.length} bytes; not a WinBolo replay`);
		}
		/* the archive's members inflate first; parsing then yields for the bar */
		let log_bytes;
		if (WinBoloZip.is_zip(bytes)) {
			let members = {};
			for (let entry of WinBoloZip.entries(bytes)) {
				members[entry.name] = entry.method === WinBoloZip.METHOD_STORE ? entry.data : await WinBoloInflate.inflate_raw(entry.data);
			}
			if (!members["log.dat"]) throw new Error("the archive has no log.dat member");
			log_bytes = members["log.dat"];
			archive = { members: Object.keys(members) };
		} else {
			log_bytes = bytes;
			archive = { members: ["log.dat"] };
		}
		if (generation !== load_generation) throw SUPERSEDED;
		let steps = WinBoloLog.parse_steps(log_bytes);
		let step = steps.next();
		while (!step.done) {
			await progress("Parsing log…", 0.5 * step.value);
			step = steps.next();
		}
		let log = step.value;
		let build = WinBoloGame.build_steps(log);
		step = build.next();
		while (!step.done) {
			await progress("Reconstructing game…", 0.5 + 0.5 * step.value);
			step = build.next();
		}
		new_game = step.value;
		new_game.map_names = announced_map_names(new_game.server_messages);
		await loading_stage("Opening replay…", 1);
		if (generation !== load_generation) throw SUPERSEDED;
	} catch (err) {
		if (err === SUPERSEDED) return; /* the newer load owns the viewer now */
		let restore = before_load;
		loading = false;
		before_load = null;
		if (cur) draw();
		else {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
		}
		if (restore.drop_hint) drop_hint.classList.remove("hidden");
		set_playing(restore.playing);
		show_error("Could not load replay", String(err.message || err));
		return;
	}
	loading = false;
	before_load = null;
	game = new_game;
	player_locked = false;
	update_lock_indicator();
	viewpoint = -1;
	last_viewpoint_html = null;
	last_players_html = null;
	effect_lo = 0;
	set_clock(game.t0, true);

	drop_hint.classList.add("hidden");
	loaded_name = name || null;
	document.title = (name ? name.split(/[\\/]/).pop() + " — " : "") + "WinBolo Replay Viewer";
	let h = game.header;
	version_meta_el.textContent = `WinBolo ${h.bolo_version} · log v${h.version}`;
	game_type_meta_el.textContent = [
		WinBoloLog.GAME_TYPES[h.game_type] || `game type ${h.game_type}`,
		h.created ? "Server started " + new Date(h.created * 1000).toISOString().slice(0, 10) : "",
	].filter(Boolean).join(" · ");
	game_type_meta_el.title = h.created ? "by the server's own clock; the server may have run earlier games since" : "";
	for (let w of game.log.warnings) console.warn("replay:", w);

	rebuild_chat(clock);
	zoom_to_action();
	set_playing(true);
	if (window.api && name) window.api.file_loaded(name);
}

function show_error(title, message) {
	if (window.api) window.api.show_error(title, message);
	else alert(`${title}: ${message}`);
}

/* ---------- input ---------- */
function toggle_obj_sprites() { use_obj_sprites = !use_obj_sprites; request_draw(); }
function toggle_lgm_sprites() { use_lgm_sprites = !use_lgm_sprites; request_draw(); }
function toggle_big_shots() { use_big_shots = !use_big_shots; request_draw(); }
function toggle_simple_terrain() { use_simple_terrain = !use_simple_terrain; request_draw(); }
function toggle_neutral_pill_colour() { use_neutral_pill_colour = !use_neutral_pill_colour; request_draw(); }
function toggle_coordinate_debug() { coordinate_debug_enabled = !coordinate_debug_enabled; update_coordinate_debug(); }
function toggle_pillbox_ids() { pillbox_ids_enabled = !pillbox_ids_enabled; request_draw(); }
function toggle_event_messages() {
	event_messages_enabled = !event_messages_enabled;
	if (game) rebuild_chat(clock);
}
function toggle_pregame_messages() {
	pregame_messages_enabled = !pregame_messages_enabled;
	if (game) rebuild_chat(clock);
}

function toggle_player_lock() {
	if (!game || viewpoint < 0) return;
	player_locked = !player_locked;
	update_lock_indicator();
	centre_locked_player();
	request_draw();
}

/* The lock's only always-on indicator: the player selector goes friendly
 * green while the view is locked to its player. */
function update_lock_indicator() {
	viewpoint_el.classList.toggle("locked", player_locked);
}

/* Controls give focus back to the window once used, so they don't sit
 * highlighted and don't capture the global playback keys (space, arrows). */
play_btn.addEventListener("click", () => {
	set_playing(!playing);
	play_btn.blur();
});
speed_el.addEventListener("change", () => {
	speed = parseFloat(speed_el.value);
	speed_el.blur();
});
viewpoint_el.addEventListener("change", () => {
	viewpoint = parseInt(viewpoint_el.value, 10);
	viewpoint_el.blur();
	centre_locked_player();
	request_draw();
});
seek_el.addEventListener("input", () => {
	if (!game) return;
	let tick = game.t0 + (parseInt(seek_el.value, 10) / 1000) * (game.t1 - game.t0);
	set_clock(tick, tick < clock);
});
seek_el.addEventListener("pointerup", () => seek_el.blur());
seek_el.addEventListener("change", () => seek_el.blur());

/* Save the map as it was when the game began (the first full snapshot
 * after the start), as a standard BMAPBOLO file: terrain, pills, bases
 * and starts. */
function save_map() {
	if (!game) return;
	let start = WinBoloGame.state_at(game, game.t0).state;
	let owner = o => o > 15 ? 16 : o; /* WinBolo's 0xff neutral is the codec's 16 */
	let map = {
		grid: start.grid,
		pills: start.pills.map(p => ({ x: p.x, y: p.y, owner: owner(p.owner), armour: p.armour, speed: p.speed ?? 50 })),
		bases: start.bases.map(b => ({ x: b.x, y: b.y, owner: owner(b.owner), armour: b.armour, shells: b.shells, mines: b.mines })),
		starts: start.starts.map(s => ({ x: s.x, y: s.y, dir: s.dir })),
	};
	let bytes;
	try {
		bytes = BoloMap.serialize_map(map);
	} catch (err) {
		show_error("Could not build map", String(err.message || err));
		return;
	}
	let name = (map_name_el.textContent || "map").replace(/[\/\\:]/g, "_") + ".map";
	if (window.api) {
		window.api.save_map(name, bytes).then(res => {
			if (res.error) show_error("Could not save map", res.error);
		});
	} else {
		let a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
		a.download = name;
		a.click();
		URL.revokeObjectURL(a.href);
	}
}

/* F1-F8 speeds: the classic doubling ladder, whatever the menu offers. */
const FKEY_SPEEDS = [0.5, 1, 2, 4, 8, 16, 32, 64];

window.addEventListener("keydown", e => {
	if (e.code === "Escape" && window.api) {
		e.preventDefault();
		window.api.exit_fullscreen();
		return;
	}
	if (PAGE_SHORTCUTS && e.code === "KeyO" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
		e.preventDefault(); /* no menu accelerator: Ctrl+O is our open, not the browser's */
		open_log();
		return;
	}
	if (e.code === "F11" && window.api && window.api.toggle_fullscreen) {
		e.preventDefault();
		window.api.toggle_fullscreen();
		return;
	}
	if (toggle_key(e, "KeyD")) {
		e.preventDefault();
		toggle_coordinate_debug();
		return;
	}
	if (toggle_key(e, "KeyI") && !e.shiftKey) {
		e.preventDefault();
		toggle_pillbox_ids();
		return;
	}
	if (!game) return;
	if (PAGE_SHORTCUTS && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
		/* Electron's zoom accelerators, which a browser would otherwise take as page zoom */
		if (e.code === "Equal" || e.code === "NumpadAdd") {
			e.preventDefault();
			zoom_step(1);
			return;
		} else if (e.code === "Minus" || e.code === "NumpadSubtract") {
			e.preventDefault();
			zoom_step(-1);
			return;
		} else if (e.code === "Digit0" || e.code === "Numpad0") {
			e.preventDefault();
			centre_map();
			return;
		}
	}
	if (e.code === "KeyS" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault(); /* it's our save now, not the browser's */
		save_map();
		return;
	}
	if (/^F[1-8]$/.test(e.code)) {
		e.preventDefault();
		speed = FKEY_SPEEDS[parseInt(e.code.slice(1), 10) - 1];
		speed_el.value = String(speed);
		speed_el.blur();
	} else if (e.code === "Space") {
		e.preventDefault();
		set_playing(!playing);
	} else if (e.code === "ArrowDown") {
		e.preventDefault();
		step_change(1);
	} else if (e.code === "ArrowUp") {
		e.preventDefault();
		step_change(-1);
	} else if (e.code === "Home") {
		e.preventDefault();
		go_to_boundary(false);
	} else if (e.code === "End") {
		e.preventDefault();
		go_to_boundary(true);
	} else if (e.code === "ArrowLeft") {
		set_clock(clock - TPS * (e.shiftKey ? 60 : 10), true);
	} else if (e.code === "ArrowRight") {
		set_clock(clock + TPS * (e.shiftKey ? 60 : 10));
	} else if (toggle_key(e, "KeyL")) {
		e.preventDefault();
		toggle_player_lock();
	} else if (toggle_key(e, "KeyG")) {
		e.preventDefault();
		toggle_obj_sprites();
	} else if (toggle_key(e, "KeyM")) {
		e.preventDefault();
		toggle_lgm_sprites();
	} else if (toggle_key(e, "KeyB")) {
		e.preventDefault();
		toggle_big_shots();
	} else if (toggle_key(e, "KeyN")) {
		e.preventDefault();
		toggle_neutral_pill_colour();
	} else if (toggle_key(e, "KeyT")) {
		e.preventDefault();
		toggle_simple_terrain();
	} else if (toggle_key(e, "KeyE")) {
		e.preventDefault();
		toggle_event_messages();
	} else if (toggle_key(e, "KeyP")) {
		e.preventDefault();
		toggle_pregame_messages();
	}
});

let panning = false, pan_start = null;
canvas.addEventListener("pointerdown", e => {
	pointer_buttons = e.buttons;
	hover_point = hover_point_from_event(e);
	update_coordinate_debug();
	panning = true;
	pan_start = { mx: e.offsetX, my: e.offsetY, ox: view.ox, oy: view.oy };
	canvas.setPointerCapture(e.pointerId);
	canvas.style.cursor = "grabbing";
});
canvas.addEventListener("pointermove", e => {
	pointer_buttons = e.buttons;
	hover_point = hover_point_from_event(e);
	if (panning && pan_start) {
		if (e.offsetX !== pan_start.mx || e.offsetY !== pan_start.my) {
			player_locked = false;
			update_lock_indicator();
		}
		view.ox = pan_start.ox - (e.offsetX - pan_start.mx) / view.zoom;
		view.oy = pan_start.oy - (e.offsetY - pan_start.my) / view.zoom;
		clamp_view();
		request_draw();
	}
	update_coordinate_debug();
});
function end_pan(e) {
	panning = false;
	pan_start = null;
	pointer_buttons = e.buttons;
	if (e.type === "pointercancel") hover_point = null;
	else hover_point = hover_point_from_event(e);
	canvas.style.cursor = "grab";
	update_coordinate_debug();
}
canvas.addEventListener("pointerup", end_pan);
canvas.addEventListener("pointercancel", end_pan);
canvas.addEventListener("pointerleave", () => {
	hover_point = null;
	update_coordinate_debug();
});
canvas.addEventListener("pointerenter", e => {
	pointer_buttons = e.buttons;
	hover_point = hover_point_from_event(e);
	update_coordinate_debug();
});

canvas.addEventListener("wheel", e => {
	e.preventDefault();
	let idx = ZOOMS.indexOf(view.zoom);
	let nidx = Math.max(0, Math.min(ZOOMS.length - 1, idx + (e.deltaY < 0 ? 1 : -1)));
	zoom_to(ZOOMS[nidx], e.offsetX, e.offsetY);
}, { passive: false });

/* file loading: Electron IPC when available, else drag-drop / file picker */
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => {
	e.preventDefault();
	take_file(e.dataTransfer.files[0]);
});
drop_hint.addEventListener("click", open_log);
file_pick.addEventListener("change", () => {
	take_file(file_pick.files[0]);
});

function take_file(f) {
	if (!f) return;
	if (f.size > MAX_LOG_BYTES) {
		show_error("Could not load replay", `${f.name} is ${f.size} bytes; not a WinBolo replay`);
		return;
	}
	let file_path = window.api ? window.api.file_path(f) : f.name;
	f.arrayBuffer().then(
		ab => load_log(new Uint8Array(ab), file_path),
		err => show_error("Could not read file", String(err)));
}

/* Ask for a replay: the native dialog in the apps (which remembers the
 * last directory), the browser's file picker on the web. */
function open_log() {
	if (WEB) {
		file_pick.click();
		return;
	}
	window.api.open_log().then(res => {
		if (!res.canceled && res.data) load_log(res.data, res.path);
		else if (res.error) show_error("Could not open replay", res.error);
	});
}

if (window.api) {
	window.api.on_load_log(payload => load_log(payload.data, payload.path));
	window.api.on_menu(cmd => {
		switch (cmd) {
			case "open": open_log(); break;
			case "play-pause": set_playing(!playing); break;
			case "previous-change": step_change(-1); break;
			case "next-change": step_change(1); break;
			case "go-to-beginning": go_to_boundary(false); break;
			case "go-to-end": go_to_boundary(true); break;
			case "zoom-in": zoom_step(1); break;
			case "zoom-out": zoom_step(-1); break;
			case "centre-map": centre_map(); break;
			case "toggle-player-lock": toggle_player_lock(); break;
			case "toggle-obj-sprites": toggle_obj_sprites(); break;
			case "toggle-lgm-sprites": toggle_lgm_sprites(); break;
			case "toggle-big-shots": toggle_big_shots(); break;
			case "toggle-simple-terrain": toggle_simple_terrain(); break;
			case "toggle-neutral-pill-colour": toggle_neutral_pill_colour(); break;
			case "toggle-event-messages": toggle_event_messages(); break;
			case "toggle-pregame-messages": toggle_pregame_messages(); break;
			case "toggle-coordinate-debug": toggle_coordinate_debug(); break;
			case "toggle-pillbox-ids": toggle_pillbox_ids(); break;
			case "save-map": save_map(); break;
		}
	});
}

/* ---------- canvas sizing ---------- */

/* The view is stored by its top-left corner, so a resize would otherwise
 * keep that corner fixed and let the centre drift. Shifting the corner by
 * half the size change keeps the camera centred. */
let last_size = { w: 0, h: 0 };
function resize() {
	let w = canvas.clientWidth, h = canvas.clientHeight;
	if (last_size.w && last_size.h) {
		view.ox += (last_size.w - w) / (2 * view.zoom);
		view.oy += (last_size.h - h) / (2 * view.zoom);
	}
	last_size = { w, h };
	canvas.width = Math.max(1, Math.round(w * devicePixelRatio));
	canvas.height = Math.max(1, Math.round(h * devicePixelRatio));
	request_draw();
}
new ResizeObserver(resize).observe(canvas);
window.addEventListener("resize", resize);

let loaded_name = null;

/* tiny hooks for headless tests and the dev console */
window.WBV = {
	get filename() { return loaded_name; },
	get game() { return game; },
	get state() { return cur; },
	get clock() { return clock; },
	get view() { return view; },
	load(bytes, name) { return load_log(bytes, name); },
	seek(tick) { set_playing(false); set_clock(tick, true); },
	play(p) { set_playing(p); },
	centre_at(tx, ty) {
		let { w, h } = css_size();
		view.ox = tx - w / (2 * view.zoom);
		view.oy = ty - h / (2 * view.zoom);
		request_draw();
		return true;
	},
	zoom(z) { zoom_to(z); },
	draw() { draw(); },
};

BoloSprites.load(request_draw);
load_obj_sprites();
resize();
zoom_label.textContent = `zoom ${view.zoom}×`;
