"use strict";

/* The Tauri app's window.api: the same interface preload.js gives the
 * Electron app, so renderer.js need not know which desktop shell it runs
 * in. Loaded before renderer.js; does nothing in Electron (which already
 * has window.api) or in a browser (no window.__TAURI__).
 *
 * Bytes cross the bridge raw in both directions: a Uint8Array argument
 * goes as the request body, a Rust Response comes back as an ArrayBuffer.
 * A replay the host read arrives in two steps: its path and an id, then
 * its bytes, fetched by that id. */

(function() {
	if (window.api || !window.__TAURI__) return;

	let invoke = window.__TAURI__.core.invoke;
	let listen = window.__TAURI__.event.listen;

	function error_of(err) {
		return String((err && err.message) || err);
	}

	function take_log_bytes(id) {
		return invoke("take_log_bytes", { id }).then(ab => new Uint8Array(ab));
	}

	/* A replay the host offered (by event, or listed at startup): fetch its
	 * bytes and hand both to the page. One no longer held is passed over. */
	function deliver_log(cb, offer) {
		take_log_bytes(offer.id).then(data => cb({ path: offer.path, data }), () => {});
	}

	window.api = {
		/* no menu accelerators here: the page owns Ctrl+O, the zoom keys and F11 too */
		page_shortcuts: true,

		open_log: () => invoke("open_log").then(async res => {
			if (res.canceled) return res;
			return { canceled: false, path: res.path, data: await take_log_bytes(res.id) };
		}).catch(err => ({ canceled: true, error: error_of(err) })),

		save_map: (name, data) => invoke("save_map", data, { headers: { "x-name": encodeURIComponent(name) } })
			.catch(err => ({ canceled: true, error: error_of(err) })),

		/* files reach the page by the native drop below, never as File objects with a path */
		file_path: file => file.name,

		/* Electron's native title follows document.title; Tauri's has to be told */
		file_loaded: file_path => invoke("file_loaded", { path: file_path, title: document.title }),
		show_file: () => invoke("show_file"),
		exit_fullscreen: () => invoke("exit_fullscreen"),
		toggle_fullscreen: () => invoke("toggle_fullscreen"),

		/* replays the host read itself: those waiting at startup (one named
		 * on the command line, any dropped before the page listened) and
		 * any dropped on the window later */
		on_load_log: cb => {
			listen("load-log", e => deliver_log(cb, e.payload));
			invoke("pending_logs").then(offers => {
				for (let offer of offers) deliver_log(cb, offer);
			});
		},

		show_error: (title, message) => invoke("show_error", { title, message }),
		on_menu: cb => listen("menu-cmd", e => cb(e.payload)),
	};
})();
