/* Replay engine: turns a parsed WinBolo log into world state at any tick.
 * The server's periodic snapshots are the keyframes; the events between
 * them replay forward. No DOM use, so node tests can load it too. */
"use strict";
(function () {

const WinBoloLog = typeof module !== "undefined" && module.exports
	? require("../src/parse.js") : window.WinBoloLog;

const { MAP_SIZE, DEEP_SEA, NEUTRAL, MAX_TANKS, TICKS_PER_SECOND } = WinBoloLog;
const EV = WinBoloLog.EVENT;

/* Transient effects (from the sound events) stay on screen this long. */
const EFFECT_TICKS = 30;

/* ---------- shell tracking ----------
 * The log names no shell: each tick lists every shell in flight (square,
 * pixel, 16-way direction) and every explosion (square, pixel, animation
 * stage) as the server holds them. But the server's view is exact and
 * restated every tick, so the lists link up: a shell moves SHELL_SPEED
 * (32 world units, an eighth of a tile) along its heading each tick, it
 * is born at the centre of the tank or pillbox that fired it, and when it
 * dies its flight position stops and a fresh burst appears one tick
 * later, a step along its heading. From that the tracker gives each shell
 * an owner and each burst a cause: terrain (a MapChange at the spot that
 * tick), a pillbox (PillSetHealth on the pillbox there), a tank (one
 * within a tile), or a fall, the shell landing at the end of its range
 * with nothing in its way. Falls draw as the gentle splash of the Ancient
 * Bolo viewer instead of the fireball the log animates. */
const SHELL_STEP = 32 / 256;             /* tiles per tick */
const TRACK_TOLERANCE = 0.2;             /* tiles: a shell's next position against its predicted one */
/* A burst against the track it ends. A fall bursts at the shell's own
 * position; a pillbox or terrain hit snaps the burst to the centre of the
 * square hit (shellsCalcCollision), up to 0.7 tiles from the shell, and a
 * tank hit bursts where the shell struck. So a burst may sit anywhere
 * from a little behind the last position to a few steps ahead, within
 * a square's reach across the heading. */
const BURST_AHEAD = 1.0;                 /* tiles ahead of the last position, at most */
const BURST_BEHIND = 0.4;                /* tiles behind it, at most (the snap can pull it back) */
const BURST_ACROSS = 0.8;                /* tiles off the heading, at most */
const MUZZLE_TOLERANCE = 1.0;            /* tiles: a new shell against the tank or pill that fired it (its first logged position is already most of a tile out) */
const TANK_HIT_BOX = 0.5 + 1 / 32;       /* tiles: tankIsTankHit takes a shell within 128 world units (half a tile) of the centre on both axes; the 1/32 is pixel rounding */
const BURST_FRAME_TICKS = 28;            /* a burst animates for 23 ticks (stage 8 for two, the rest for three each), with slack */
const TRACK_GRACE_TICKS = 3;             /* a burst follows its last flight position after at most this many ticks */
const DIR_VECTORS = Array.from({ length: 16 }, (_, d) => {
	let a = d / 16 * 2 * Math.PI; /* 0 north, clockwise */
	return [Math.sin(a), -Math.cos(a)];
});
const PILL_OWNER = "pill";
const CRATER = 3, MINE_START = 10;
const MINE_KILL_TICKS = 30;              /* a mine blast this recent under a dying tank is what killed it (a chain takes ~10 ticks a square) */
const SINK_TICKS = 4;                    /* a hit and the boat flag dropping this recently before a drowning: the boat was shot from under the tank */
const TEAM_MESSAGE_TICKS = 25;           /* copies of one team message to its recipients arrive within this many ticks */

function shell_tracker() {
	return { tracks: [], ended: [], bursts: new Map() };
}

function burst_key(e) {
	return (e.mx << 16) | (e.px << 12) | (e.my << 4) | e.py;
}

/* Process one tick's Shell events once the tick is complete: extend the
 * tracks, start new ones at muzzles, and explain the bursts. Marks the
 * events themselves (owner, age, cause) so the state and the renderer
 * see the verdicts. Falls add a splash effect and a fall segment. */
function track_tick(tr, tick, tick_events, state, effects, fall_segments) {
	let flights = [], bursts = [];
	for (let e of tick_events) {
		if (e.type !== EV.Shell) continue;
		if (e.dir !== undefined) flights.push(e);
		else bursts.push(e);
	}
	if (!flights.length && !bursts.length && !tr.tracks.length) return;

	/* extend tracks: each to the nearest shell at its predicted position */
	let pairs = [];
	for (let i = 0; i < tr.tracks.length; i++) {
		let t = tr.tracks[i];
		let px = t.x + DIR_VECTORS[t.dir][0] * SHELL_STEP, py = t.y + DIR_VECTORS[t.dir][1] * SHELL_STEP;
		for (let j = 0; j < flights.length; j++) {
			let f = flights[j];
			if (f.dir !== t.dir) continue;
			let d = Math.hypot(world_x(f) - px, world_y(f) - py);
			if (d <= TRACK_TOLERANCE) pairs.push([d, i, j]);
		}
	}
	pairs.sort((a, b) => a[0] - b[0]);
	let track_used = new Set(), flight_used = new Set();
	let next = [];
	for (let [, i, j] of pairs) {
		if (track_used.has(i) || flight_used.has(j)) continue;
		track_used.add(i); flight_used.add(j);
		let t = tr.tracks[i], f = flights[j];
		t.x = world_x(f); t.y = world_y(f); t.age++; t.last_tick = tick;
		f.owner = t.owner; f.age = t.age;
		next.push(t);
	}
	for (let i = 0; i < tr.tracks.length; i++) {
		if (!track_used.has(i)) tr.ended.push(tr.tracks[i]);
	}
	/* new shells: born at the muzzle of a tank or a pillbox, which lies
	 * behind the shell along its heading; the nearest such wins */
	for (let j = 0; j < flights.length; j++) {
		if (flight_used.has(j)) continue;
		let f = flights[j];
		let x = world_x(f), y = world_y(f);
		let [hx, hy] = DIR_VECTORS[f.dir];
		let owner = null, best = MUZZLE_TOLERANCE;
		let consider = (mx, my, who) => {
			let dx = x - mx, dy = y - my;
			let d = Math.hypot(dx, dy);
			if (d <= best && dx * hx + dy * hy >= -0.25) { best = d; owner = who; }
		};
		for (let p of state.players) {
			if (p.tank.in_world) consider(world_x(p.tank), world_y(p.tank), p.slot);
		}
		for (let p of state.pills) {
			if (!p.in_tank && p.armour > 0) consider(p.x + 0.5, p.y + 0.5, PILL_OWNER);
		}
		f.owner = owner; f.age = 0;
		next.push({ x, y, dir: f.dir, age: 0, owner, born: tick, last_tick: tick });
	}
	tr.tracks = next;
	tr.ended = tr.ended.filter(t => tick - t.last_tick <= TRACK_GRACE_TICKS);

	for (let e of bursts) {
		let key = burst_key(e);
		let known = tr.bursts.get(key);
		if (known && tick - known.tick <= BURST_FRAME_TICKS) {
			e.cause = known.cause; e.owner = known.owner;
			continue;
		}
		/* The stages step down every third tick on a clock shared by all
		 * explosions, so a fresh burst is first logged at stage 8 or, when
		 * the step falls on its first tick, already at 7. Anything lower
		 * with no known burst began before this tick's view of it. */
		if (e.explosion < 7) continue;
		/* a fresh burst: the track that ends here, if any: the one whose
		 * heading passes closest, with the burst ahead of its last position */
		let bx = world_x(e) + 0.5, by = world_y(e) + 0.5; /* the burst tile's centre; see renderer */
		let best = null, best_score = Infinity;
		for (let t of tr.ended) {
			let [hx, hy] = DIR_VECTORS[t.dir];
			let dx = bx - t.x, dy = by - t.y;
			let along = dx * hx + dy * hy;
			let across = Math.abs(dx * hy - dy * hx);
			if (along < -BURST_BEHIND || along > BURST_AHEAD || across > BURST_ACROSS) continue;
			/* the expected point is a step per tick since the last position */
			let expected = SHELL_STEP * (tick - t.last_tick);
			let score = across + Math.abs(along - expected) * 0.5;
			if (score < best_score) { best_score = score; best = t; }
		}
		if (!best) continue; /* a mine going off, or tank wreckage landing */
		tr.ended = tr.ended.filter(t => t !== best);
		let { cause, victim } = burst_cause(e, state, bx, by, best.owner);
		e.cause = cause; e.owner = best.owner; e.age = best.age;
		if (victim !== undefined) {
			/* remembered on the tank, for a drowning that follows */
			let t = state.players[victim].tank;
			t.hit_at = tick;
			t.hit_by = best.owner;
		}
		tr.bursts.set(key, { tick, cause, owner: best.owner });
		if (cause === "fall") {
			if (effects) effects.push({ tick, type: "splash", x: bx, y: by });
			if (fall_segments) fall_segments.push({ start: best.last_tick, end: tick, from_x: best.x, from_y: best.y, to_x: bx, to_y: by, dir: best.dir, owner: best.owner });
		}
	}
	if (tr.bursts.size > 64) {
		for (let [key, b] of tr.bursts) if (tick - b.tick > BURST_FRAME_TICKS) tr.bursts.delete(key);
	}
}

/* What a burst hit. A collision with a square's contents (a pillbox,
 * alive or dead; a building or tree; the shore, for a shell fired from a
 * boat) snaps the burst to that square's centre, so the burst's corner
 * pixel is the square's origin: that is the sign of a square hit, and
 * the square's pillbox, if any, is what was hit. A burst elsewhere is
 * the shell's own position: a tank hit if a tank is within reach (never
 * the shooter's own), else the shell falling at the end of its range. */
function burst_cause(burst, state, bx, by, owner) {
	if (burst.px === 0 && burst.py === 0) {
		let sx = Math.floor(bx), sy = Math.floor(by);
		return { cause: state.pills.some(p => !p.in_tank && p.x === sx && p.y === sy) ? "pill" : "terrain" };
	}
	for (let p of state.players) {
		let t = p.tank;
		if (p.slot === owner) continue;
		let dying = t.died_at === state.tick;
		if (!t.in_world && !dying) continue;
		/* a tank's logged position can lag its true one by a pixel or two
		 * (it is logged only when it changes); a tank dying this very tick
		 * is allowed the slack */
		let reach = dying ? TANK_HIT_BOX * 2 : TANK_HIT_BOX;
		if (Math.abs(world_x(t) - bx) < reach && Math.abs(world_y(t) - by) < reach) return { cause: "tank", victim: p.slot };
	}
	return { cause: "fall" };
}

/* The fall segments overlapping a tick: a landing shell drawn on from its
 * last logged position to its splash. */
function fall_positions_at(game, tick) {
	let segments = game.fall_segments;
	let lo = 0, hi = segments.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (segments[mid].start < tick - TRACK_GRACE_TICKS) lo = mid + 1;
		else hi = mid;
	}
	let out = [];
	for (let i = lo; i < segments.length && segments[i].start <= tick; i++) {
		let s = segments[i];
		if (tick >= s.end) continue;
		let amount = (tick - s.start) / (s.end - s.start);
		out.push({ x: s.from_x + (s.to_x - s.from_x) * amount, y: s.from_y + (s.to_y - s.from_y) * amount, dir: s.dir, owner: s.owner });
	}
	return out;
}
/* Shells and men are restated every tick they exist; a state older than
 * this at the playback clock no longer shows them. */
const RESTATEMENT_TICKS = 1;

function fresh_player(slot) {
	return {
		slot, in_use: false, name: null, location: "", allies: [], quit: false,
		tank: { mx: 0, my: 0, px: 0, py: 0, dir: 0, on_boat: false, in_world: false, last_seen: -1 },
		lgm: { mx: 0, my: 0, px: 0, py: 0, frame: 0, out: false, last_seen: -1 },
	};
}

function initial_state() {
	let grid = new Uint8Array(MAP_SIZE * MAP_SIZE);
	grid.fill(DEEP_SEA);
	return {
		tick: -1, grid, grid_version: 0, pills: [], bases: [], starts: [],
		players: Array.from({ length: MAX_TANKS }, (_, i) => fresh_player(i)),
		shells: [], start_delay: 0, game_length: 0, mine_blasts: [],
	};
}

/* The world as a snapshot records it. Names survive from the previous
 * state where the snapshot has none (a slot not in use keeps its label in
 * the sidebar until reused), so the previous state is passed along. */
function state_from_snapshot(s, previous) {
	let st = initial_state();
	st.tick = s.tick - 1;
	st.grid = WinBoloLog.snapshot_grid(s).slice();
	st.grid_version = s.tick;
	st.pills = s.pills.map(p => ({ x: p.x, y: p.y, armour: p.armour, owner: p.owner, in_tank: p.in_tank, speed: p.speed }));
	st.bases = s.bases.map(b => ({ x: b.x, y: b.y, owner: b.owner, armour: b.armour, shells: b.shells, mines: b.mines }));
	st.starts = s.starts.map(x => ({ x: x.x, y: x.y, dir: x.dir }));
	st.start_delay = s.start_delay;
	st.game_length = s.game_length;
	for (let i = 0; i < MAX_TANKS; i++) {
		let p = s.players[i];
		let pl = st.players[i];
		let prev = previous ? previous.players[i] : null;
		if (!p || !p.in_use) {
			if (prev) { pl.name = prev.name; pl.location = prev.location; pl.quit = prev.quit; }
			continue;
		}
		pl.in_use = true;
		pl.name = p.name;
		pl.location = p.location;
		pl.allies = p.allies.slice();
		let t = p.tank;
		pl.tank = { mx: t.mx, my: t.my, px: t.px, py: t.py, dir: t.frame & 15, on_boat: t.on_boat,
			in_world: t.mx !== 0 || t.my !== 0, last_seen: s.tick };
		/* the man is only drawn while restated, so he starts hidden and
		 * the next LgmLocation shows him */
		pl.lgm = { mx: p.lgm.mx, my: p.lgm.my, px: p.lgm.px, py: p.lgm.py, frame: p.lgm.frame, out: false, last_seen: -1 };
	}
	return st;
}

function clone_state(s) {
	return {
		tick: s.tick, grid: s.grid.slice(), grid_version: s.grid_version,
		pills: s.pills.map(p => ({ ...p })), bases: s.bases.map(b => ({ ...b })), starts: s.starts.map(x => ({ ...x })),
		players: s.players.map(p => ({ ...p, allies: p.allies.slice(), tank: { ...p.tank }, lgm: { ...p.lgm } })),
		shells: s.shells.slice(), start_delay: s.start_delay, game_length: s.game_length, mine_blasts: s.mine_blasts.slice(),
	};
}

function name_of(s, p) {
	let pl = s.players[p];
	return (pl && pl.name) || `player ${p}`;
}

/* Alliance team id for colouring: lowest slot in the player's group. */
function team_of(s, p) {
	let pl = s.players[p];
	if (!pl) return p;
	let t = p;
	for (let a of pl.allies) if (a < t) t = a;
	return t;
}

function ally(s, a, b) {
	if (a === b || a >= MAX_TANKS || b >= MAX_TANKS) return;
	/* A joins B's group: everyone in either group allies with everyone in
	 * the other, so the lists stay symmetric and complete. */
	let group_a = [a, ...s.players[a].allies];
	let group_b = [b, ...s.players[b].allies];
	for (let x of group_a) {
		for (let y of group_b) {
			if (x === y) continue;
			if (!s.players[x].allies.includes(y)) s.players[x].allies.push(y);
			if (!s.players[y].allies.includes(x)) s.players[y].allies.push(x);
		}
	}
}

function unally(s, p) {
	if (p >= MAX_TANKS) return;
	for (let q of s.players[p].allies) {
		s.players[q].allies = s.players[q].allies.filter(x => x !== p);
	}
	s.players[p].allies = [];
}

/* Did a mine just go off under (or next to) this tank? */
function mine_under(s, t, tick) {
	return s.mine_blasts.some(b => tick - b.tick <= MINE_KILL_TICKS && Math.abs(b.x + 0.5 - world_x(t)) <= 1.5 && Math.abs(b.y + 0.5 - world_y(t)) <= 1.5);
}

/* World position (tile units, tile centres at .5) of a tank, man or shell
 * from its square and pixel-within-square: WinBolo positions are the
 * object's centre. */
function world_x(o) { return o.mx + o.px / 16; }
function world_y(o) { return o.my + o.py / 16; }

/* Apply one event. effects and chat, when given, collect the transient
 * visuals and the message wire (only during the build pass). */
function apply_event(s, e, effects, chat) {
	if (e.tick !== s.tick) {
		/* a new tick: last tick's restated objects are gone until restated */
		s.tick = e.tick;
		s.shells = [];
		for (let pl of s.players) pl.lgm.out = false;
	}
	let pl = e.player < MAX_TANKS ? s.players[e.player] : null;
	let push_chat = (kind, extra) => {
		if (chat) chat.push({ tick: e.tick, kind, player: e.player, name: name_of(s, e.player), team: team_of(s, e.player), ...extra });
	};
	switch (e.type) {
		case EV.PlayerJoined:
			if (!pl) break;
			s.players[e.player] = fresh_player(e.player);
			pl = s.players[e.player];
			pl.in_use = true;
			pl.name = e.player_name;
			pl.location = e.country || "";
			push_chat("join", { text: e.player_name, country: e.country });
			break;
		case EV.PlayerQuit:
			if (!pl) break;
			pl.in_use = false;
			pl.quit = true;
			pl.tank.in_world = false;
			pl.lgm.out = false;
			unally(s, e.player);
			push_chat("quit");
			break;
		case EV.PlayerRejoin:
			if (pl) pl.quit = false;
			push_chat("rejoin");
			break;
		case EV.PlayerLeaving:
			break;
		case EV.PlayerLocation:
			if (!pl) break;
			if (e.in_world) {
				let was = pl.tank;
				pl.tank = { mx: e.mx, my: e.my, px: e.px, py: e.py, dir: e.dir, on_boat: e.on_boat, in_world: true, last_seen: e.tick,
					hit_at: was.hit_at, hit_by: was.hit_by, boat_lost_at: was.boat_lost_at };
				if (was.in_world && was.on_boat && !e.on_boat) pl.tank.boat_lost_at = e.tick;
			} else {
				/* a dead tank is logged at 0,0 at the end of its death tick;
				 * keep where it died, for the burst that killed it. A tank
				 * that vanishes with no death logged died to a mine (the
				 * server logs no KillPlayer or PlayerDied for one) or to
				 * something else it does not log, such as deep water. */
				if (pl.tank.in_world && pl.tank.died_at !== e.tick && !pl.quit) {
					pl.tank.died_at = e.tick;
					if (effects) effects.push({ tick: e.tick, type: "tank_death", x: world_x(pl.tank), y: world_y(pl.tank) });
					push_chat(mine_under(s, pl.tank, e.tick) ? "mine_kill" : "died");
				}
				pl.tank.in_world = false;
				pl.tank.last_seen = e.tick;
			}
			break;
		case EV.LgmLocation:
			if (!pl) break;
			pl.lgm = { mx: e.mx, my: e.my, px: e.px, py: e.py, frame: e.frame, out: true, last_seen: e.tick };
			break;
		case EV.MapChange:
			if (e.terrain === CRATER && s.grid[e.y * MAP_SIZE + e.x] >= MINE_START) {
				/* a mine went off: remembered briefly, to tell a mine kill from a pillbox's */
				s.mine_blasts.push({ tick: e.tick, x: e.x, y: e.y });
				if (s.mine_blasts.length > 16) s.mine_blasts.shift();
			}
			s.grid[e.y * MAP_SIZE + e.x] = e.terrain;
			s.grid_version++;
			break;
		case EV.Shell:
			s.shells.push(e);
			break;
		case EV.SoundShoot: case EV.SoundHitTank: case EV.SoundHitTree: case EV.SoundHitWall:
		case EV.SoundMineExplode: case EV.SoundExplosion: case EV.SoundBigExplosion: case EV.SoundManDie:
		case EV.SoundBuild: case EV.SoundFarm: case EV.SoundMineLay:
			if (effects) effects.push({ tick: e.tick, type: e.name, x: e.x, y: e.y });
			break;
		case EV.MessageServer:
			if (chat) chat.push({ tick: e.tick, kind: "server", text: e.text });
			break;
		case EV.MessageAll:
			push_chat("say", { text: e.text });
			break;
		case EV.MessagePlayers: {
			/* A team message is logged once per recipient (the sender included),
			 * a few ticks apart. Fold the copies into one line; the viewer just
			 * marks it as not sent to all, the recipients are kept for interest. */
			let last = chat && chat[chat.length - 1];
			if (last && last.kind === "say" && last.to && last.player === e.player && last.text === e.text && e.tick - last.tick <= TEAM_MESSAGE_TICKS) {
				if (!last.to.includes(e.to)) last.to.push(e.to);
				break;
			}
			push_chat("say", { text: e.text, to: [e.to] });
			break;
		}
		case EV.ChangeName: {
			if (!pl) break;
			let from = pl.name;
			pl.name = e.player_name;
			push_chat("rename", { from, text: e.player_name });
			break;
		}
		case EV.AllyRequest:
			push_chat("ally_request", { other: e.other, other_name: name_of(s, e.other) });
			break;
		case EV.AllyAccept:
			ally(s, e.player, e.other);
			push_chat("ally_accept", { other: e.other, other_name: name_of(s, e.other) });
			break;
		case EV.AllyLeave:
			unally(s, e.player);
			push_chat("ally_leave");
			break;
		case EV.BaseSetOwner:
			if (s.bases[e.base]) s.bases[e.base].owner = e.owner;
			break;
		case EV.BaseSetStock:
			if (s.bases[e.base]) Object.assign(s.bases[e.base], { shells: e.shells, mines: e.mines, armour: e.armour });
			break;
		case EV.PillSetOwner:
			if (s.pills[e.pill]) s.pills[e.pill].owner = e.owner;
			break;
		case EV.PillSetHealth:
			if (s.pills[e.pill]) s.pills[e.pill].armour = e.armour;
			break;
		case EV.PillSetPlace:
			if (s.pills[e.pill]) { s.pills[e.pill].x = e.x; s.pills[e.pill].y = e.y; }
			break;
		case EV.PillSetInTank:
			if (s.pills[e.pill]) s.pills[e.pill].in_tank = e.in_tank;
			break;
		case EV.SaveMap:
			push_chat("save_map");
			break;
		case EV.PlayerReady:
			push_chat("ready");
			break;
		case EV.PlayerUnready:
			push_chat("unready");
			break;
		case EV.CountdownStart:
			if (chat) chat.push({ tick: e.tick, kind: "countdown" });
			break;
		case EV.CountdownCancel:
			if (chat) chat.push({ tick: e.tick, kind: "countdown_cancel" });
			break;
		case EV.LobbyExit:
			if (chat) chat.push({ tick: e.tick, kind: "game_start" });
			break;
		case EV.GameVoteStart:
			push_chat("vote_called", { what: WinBoloLog.VOTE_KINDS[e.kind] || `vote kind ${e.kind}` });
			break;
		case EV.GameVoteCast:
			push_chat("vote_cast", { vote: e.vote });
			break;
		case EV.GameVoteEnd:
			if (chat) chat.push({ tick: e.tick, kind: "vote_result", what: WinBoloLog.VOTE_KINDS[e.kind] || `vote kind ${e.kind}`, passed: e.passed });
			break;
		case EV.SpectatorJoined:
			if (chat) chat.push({ tick: e.tick, kind: "spectator_join", text: e.player_name, country: e.country });
			break;
		case EV.SpectatorLeft:
			if (chat) chat.push({ tick: e.tick, kind: "spectator_quit", text: e.player_name });
			break;
		case EV.SpectatorChat:
			/* spectators have no slot; the server has never written one of these */
			if (chat) chat.push({ tick: e.tick, kind: "say", name: `spectator ${e.spectator}`, spectator: true, text: e.text });
			break;
		case EV.LostMan:
			if (!pl) break;
			/* the man's last position is logged the tick before he dies (the
			 * death is logged early in the tick, positions at its end) */
			if (effects && e.tick - pl.lgm.last_seen <= 2) effects.push({ tick: e.tick, type: "lgm_death", x: world_x(pl.lgm), y: world_y(pl.lgm), player: e.player });
			pl.lgm.out = false;
			push_chat("lost_man");
			break;
		case EV.KillPlayer:
		case EV.PlayerDied:
			if (!pl) break;
			/* version 2 logs a death as KillPlayer and PlayerDied together
			 * (the public source wrote one or the other); the second of
			 * the pair in one tick adds nothing */
			if (pl.tank.died_at === e.tick) break;
			if (effects && pl.tank.in_world) effects.push({ tick: e.tick, type: "tank_death", x: world_x(pl.tank), y: world_y(pl.tank) });
			pl.tank.in_world = false;
			pl.tank.died_at = e.tick;
			pl.lgm.out = false;
			if (e.type === EV.KillPlayer && e.killer === e.player) {
				/* a tank in deep water is logged as killed by itself: it drove
				 * in, or its boat was shot from under it (a hit on the tank
				 * and the boat flag dropping, a tick or two before) */
				let t = pl.tank;
				if (t.boat_lost_at !== undefined && e.tick - t.boat_lost_at <= SINK_TICKS && t.hit_at !== undefined && e.tick - t.hit_at <= SINK_TICKS) {
					push_chat("boat_sunk", { sinker: t.hit_by, sinker_name: t.hit_by === PILL_OWNER ? "a pillbox" : name_of(s, t.hit_by) });
				} else {
					push_chat("drowned");
				}
			} else if (e.type === EV.KillPlayer && e.killer === NEUTRAL) {
				/* the public source logs a pillbox kill as PlayerDied; version 2
				 * logs KillPlayer with the killer NEUTRAL, for a pillbox or a
				 * mine alike: a mine that just went off under the tank tells
				 * them apart (unverified: no mine death seen yet) */
				push_chat(mine_under(s, pl.tank, e.tick) ? "mine_kill" : "pill_kill");
			} else if (e.type === EV.KillPlayer) {
				push_chat("kill", { killer: e.killer, killer_name: name_of(s, e.killer) });
			} else {
				push_chat("died");
			}
			break;
		default:
			break; /* types the public source does not know: see FORMAT.md */
	}
}

/* ---------- building a game ---------- */

/* Generator: yields progress in [0, 1], returns the game. One pass over
 * the events collects the message wire, the effects and the final state;
 * seeking then works from the snapshots. */
function* build_steps(log) {
	let chat = [];
	let effects = [];
	let fall_segments = [];
	let tracker = shell_tracker();
	let tick_events = [];
	let current_tick = -1;
	let snaps = log.snapshots;
	let state = snaps.length && snaps[0].tick === 0 ? state_from_snapshot(snaps[0], null) : initial_state();
	let next_snap = snaps.length && snaps[0].tick === 0 ? 1 : 0;
	let events = log.events;
	let step = Math.max(1, events.length >> 7);
	for (let i = 0; i < events.length; i++) {
		let e = events[i];
		/* a snapshot between events resets nothing the events would not,
		 * but it is the truth: adopt it, keeping the names it lacks */
		while (next_snap < snaps.length && snaps[next_snap].event_index <= i) {
			state = state_from_snapshot(snaps[next_snap], state);
			next_snap++;
		}
		if (e.tick !== current_tick) {
			if (current_tick >= 0) track_tick(tracker, current_tick, tick_events, state, effects, fall_segments);
			tick_events = [];
			current_tick = e.tick;
		}
		apply_event(state, e, effects, chat);
		tick_events.push(e);
		if (i % step === 0) yield i / events.length;
	}
	if (current_tick >= 0) track_tick(tracker, current_tick, tick_events, state, effects, fall_segments);
	while (next_snap < snaps.length) {
		state = state_from_snapshot(snaps[next_snap], state);
		next_snap++;
	}
	let start = game_start_tick(log);
	let game = {
		log, header: log.header, events, snapshots: snaps,
		/* the lobby before the game is not part of the replay: the clock,
		 * the wire and the effects all begin at the start */
		chat: chat.filter(m => m.tick >= start && m.kind !== "game_start"), /* the replay begins there: the line would say what the clock says */
		fall_segments: fall_segments.filter(s => s.start >= start),
		/* the server's announcements from the whole log, lobby included:
		 * the map changes happen there */
		server_messages: chat.filter(m => m.kind === "server"),
		effects: effects.filter(e => e.tick >= start),
		t0: start, t1: log.ticks, final: state,
		bounds: land_bounds(state.grid),
	};
	return game;
}

function build(log) {
	let steps = build_steps(log);
	let step = steps.next();
	while (!step.done) step = steps.next();
	return step.value;
}

/* Bounding box of the land in a grid, or null for an all-sea map. */
function land_bounds(grid) {
	let minx = MAP_SIZE, miny = MAP_SIZE, maxx = -1, maxy = -1;
	for (let y = 0; y < MAP_SIZE; y++) {
		for (let x = 0; x < MAP_SIZE; x++) {
			if (grid[y * MAP_SIZE + x] !== DEEP_SEA) {
				if (x < minx) minx = x;
				if (x > maxx) maxx = x;
				if (y < miny) miny = y;
				if (y > maxy) maxy = y;
			}
		}
	}
	return maxx < 0 ? null : { minx, miny, maxx, maxy };
}

/* The tick the game begins. A server log begins when the server starts,
 * often long before anyone plays; the server marks the start with a
 * GameStart event, writes the populated world one tick later and the
 * first tank position the tick after that. The replay opens on the first
 * of those that shows a world. A log without the marker (cut off, or
 * from a server that does not write it) starts where a tank first
 * appears, and one with no tanks at all at its beginning. */
function game_start_tick(log) {
	let marker = -1;
	for (let e of log.events) {
		if (e.type === EV.LobbyExit) { marker = e.tick; break; }
	}
	for (let s of log.snapshots) {
		if (s.tick >= marker && s.players.some(p => p.in_use)) return s.tick;
	}
	for (let e of log.events) {
		if (e.type === EV.PlayerLocation && e.in_world && e.tick >= marker) return e.tick;
	}
	return Math.max(0, marker);
}

/* ---------- seeking ---------- */

/* Index of the last snapshot at or before tick (-1 if none). */
function snapshot_before(snaps, tick) {
	let lo = 0, hi = snaps.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (snaps[mid].tick <= tick) lo = mid + 1;
		else hi = mid;
	}
	return lo - 1;
}

/* First event index with an event tick >= tick. */
function event_lower_bound(events, tick) {
	let lo = 0, hi = events.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (events[mid].tick < tick) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/* State at a tick: the nearest snapshot at or before it, replayed forward
 * through every event up to and including that tick. Returns the state
 * and the index of the first event not yet applied. Player names are
 * carried forward from the last snapshot that knew them: a rejoin that
 * happened between snapshots is replayed from the events anyway. */
function state_at(game, tick) {
	tick = Math.floor(tick);
	let snaps = game.snapshots;
	let si = snapshot_before(snaps, tick);
	let state, index;
	if (si < 0) {
		state = initial_state();
		index = 0;
	} else {
		/* names of slots the snapshot marks unused come from the state
		 * just before it, which the build pass did not keep; the
		 * previous snapshot is the next best source */
		state = state_from_snapshot(snaps[si], si > 0 ? state_from_snapshot(snaps[si - 1], null) : null);
		index = snaps[si].event_index;
	}
	let events = game.events;
	while (index < events.length && events[index].tick <= tick) {
		apply_event(state, events[index], null, null);
		index++;
	}
	return { state, index };
}

/* Apply events forward from `index` through tick; returns the new index. */
function advance(game, state, index, tick) {
	let events = game.events;
	while (index < events.length && events[index].tick <= tick) {
		apply_event(state, events[index], null, null);
		index++;
	}
	return index;
}

/* The tick of the next (direction 1) or previous (-1) event block, within
 * the replay's span. */
function adjacent_change_tick(game, tick, direction) {
	let events = game.events;
	if (direction > 0) {
		let i = event_lower_bound(events, Math.floor(tick) + 1);
		return i < events.length ? Math.max(game.t0, events[i].tick) : game.t1;
	}
	let i = event_lower_bound(events, Math.ceil(tick)) - 1;
	return i >= 0 ? Math.max(game.t0, events[i].tick) : game.t0;
}

/* Objects the state restates every tick are only current while the
 * playback clock sits on the state's tick. */
function restated(state, clock) {
	return clock - state.tick <= RESTATEMENT_TICKS;
}

const WinBoloGame = {
	EFFECT_TICKS, NEUTRAL, TICKS_PER_SECOND,
	initial_state, state_from_snapshot, clone_state, apply_event, build, build_steps,
	state_at, advance, adjacent_change_tick, restated, team_of, name_of, world_x, world_y,
	land_bounds, event_lower_bound, game_start_tick, fall_positions_at, PILL_OWNER,
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = WinBoloGame;
} else {
	window.WinBoloGame = WinBoloGame;
}

})();
