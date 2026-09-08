"use strict";
/* Electron main process for the WinBolo Replay Viewer: window, menu and
 * dialog plumbing, after the Ancient Bolo Log Viewer's. */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");

let win = null;
let loaded_file_path = null;

const LOG_FILTERS = [
	{ name: "WinBolo replays", extensions: ["wbv", "dat"] },
	{ name: "All files", extensions: ["*"] },
];
const SETTINGS_DIRECTORY = "viewer-settings";
const SETTINGS_FILE = "settings.json";

/* A replay is a few MB compressed; refuse absurdities before reading. */
const MAX_LOG_BYTES = 256 << 20;

function settings_path() {
	return path.join(app.getPath("userData"), SETTINGS_DIRECTORY, SETTINGS_FILE);
}

function read_settings() {
	try {
		let settings = JSON.parse(fs.readFileSync(settings_path(), "utf8"));
		return settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
	} catch {
		return {};
	}
}

function write_settings(settings) {
	try {
		let file_path = settings_path();
		fs.mkdirSync(path.dirname(file_path), { recursive: true });
		fs.writeFileSync(file_path, JSON.stringify(settings, null, "\t") + "\n", "utf8");
	} catch { /* preferences must never prevent opening a replay */ }
}

function last_directory(key) {
	let directory = read_settings()[key];
	if (typeof directory !== "string") return undefined;
	try {
		return fs.statSync(directory).isDirectory() ? directory : undefined;
	} catch {
		return undefined;
	}
}

function remember_directory(key, file_path) {
	let settings = read_settings();
	settings[key] = path.dirname(file_path);
	write_settings(settings);
}

function send(cmd) {
	if (win) win.webContents.send("menu-cmd", cmd);
}

function show_file() {
	if (loaded_file_path) shell.showItemInFolder(loaded_file_path);
}

function toggle_fullscreen() {
	if (win) win.setFullScreen(!win.isFullScreen());
}

function build_menu() {
	let template = [
		{
			label: "&File",
			submenu: [
				{ label: "Open replay…", accelerator: "CmdOrCtrl+O", click: () => send("open") },
				{ type: "separator" },
				{ label: "Show file", click: show_file },
				{ label: "Save initial map…", accelerator: "CmdOrCtrl+S", click: () => send("save-map") },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "&Playback",
			submenu: [
				{ label: "Play / Pause", accelerator: "Space", click: () => send("play-pause") },
				{ label: "Previous Change", accelerator: "Up", click: () => send("previous-change") },
				{ label: "Next Change", accelerator: "Down", click: () => send("next-change") },
				{ label: "Go to Beginning", accelerator: "Home", click: () => send("go-to-beginning") },
				{ label: "Go to End", accelerator: "End", click: () => send("go-to-end") },
			],
		},
		{
			label: "&View",
			submenu: [
				{ label: "Zoom in", accelerator: "CmdOrCtrl+=", click: () => send("zoom-in") },
				{ label: "Zoom out", accelerator: "CmdOrCtrl+-", click: () => send("zoom-out") },
				{ label: "Centre map", accelerator: "CmdOrCtrl+0", click: () => send("centre-map") },
				{ type: "separator" },
				{ label: "Toggle player lock", accelerator: "CmdOrCtrl+L", click: () => send("toggle-player-lock") },
				{ type: "separator" },
				{ label: "Toggle simple graphics", accelerator: "CmdOrCtrl+G", click: () => send("toggle-obj-sprites") },
				{ label: "Toggle simple terrain", accelerator: "CmdOrCtrl+T", click: () => send("toggle-simple-terrain") },
				{ label: "Toggle simple LGM", accelerator: "CmdOrCtrl+M", click: () => send("toggle-lgm-sprites") },
				{ label: "Toggle big shots", accelerator: "CmdOrCtrl+B", click: () => send("toggle-big-shots") },
				{ label: "Toggle neutral pill colour", accelerator: "CmdOrCtrl+N", click: () => send("toggle-neutral-pill-colour") },
				{ type: "separator" },
				{ label: "Toggle event messages", accelerator: "CmdOrCtrl+E", click: () => send("toggle-event-messages") },
				{ type: "separator" },
				{ label: "Toggle Full Screen", accelerator: "F11", click: toggle_fullscreen },
			],
		},
		{
			label: "&Debug",
			submenu: [
				{ label: "Toggle debug coordinates", accelerator: "CmdOrCtrl+D", click: () => send("toggle-coordinate-debug") },
				{ label: "Toggle pillbox IDs", accelerator: "CmdOrCtrl+I", click: () => send("toggle-pillbox-ids") },
				{ type: "separator" },
				{ label: "Dev tools", role: "toggleDevTools" },
			]
		},
		{
			label: app.getVersion(),
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function find_cli_log() {
	for (let arg of process.argv.slice(1)) {
		if (arg.startsWith("-")) continue;
		try {
			if (fs.statSync(arg).isFile()) return path.resolve(arg);
		} catch { /* not a path */ }
	}
	return null;
}

function create_window() {
	win = new BrowserWindow({
		width: 1280,
		height: 860,
		backgroundColor: "#10131a",
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	win.loadFile("index.html");

	let cli_log = find_cli_log();
	if (cli_log) {
		win.webContents.once("did-finish-load", () => {
			try {
				let size = fs.statSync(cli_log).size;
				if (size > MAX_LOG_BYTES) throw new Error(`${cli_log} is ${size} bytes; not a WinBolo replay.`);
				win.webContents.send("load-log", { path: cli_log, data: new Uint8Array(fs.readFileSync(cli_log)) });
			} catch (err) {
				dialog.showErrorBox("Could not open replay", String(err));
			}
		});
	}
	win.on("closed", () => { win = null; });
}

ipcMain.handle("open-log", async () => {
	let options = {
		filters: LOG_FILTERS,
		properties: ["openFile"],
	};
	let directory = last_directory("last_open_directory");
	if (directory) options.defaultPath = directory;
	let res = await dialog.showOpenDialog(win, options);
	if (res.canceled || res.filePaths.length === 0) return { canceled: true };
	let p = res.filePaths[0];
	try {
		let size = fs.statSync(p).size;
		if (size > MAX_LOG_BYTES) {
			return { canceled: true, error: `${p} is ${size} bytes; not a WinBolo replay.` };
		}
		let data = new Uint8Array(fs.readFileSync(p));
		remember_directory("last_open_directory", p);
		return { canceled: false, path: p, data };
	} catch (err) {
		return { canceled: true, error: String(err) };
	}
});

ipcMain.handle("save-map", async (e, default_name, data) => {
	let directory = last_directory("last_save_directory");
	let res = await dialog.showSaveDialog(win, {
		defaultPath: directory ? path.join(directory, default_name) : default_name,
		filters: [{ name: "Bolo maps", extensions: ["map", "bmap"] }],
	});
	if (res.canceled || !res.filePath) return { canceled: true };
	try {
		fs.writeFileSync(res.filePath, Buffer.from(data));
		remember_directory("last_save_directory", res.filePath);
		return { canceled: false, path: res.filePath };
	} catch (err) {
		return { canceled: true, error: String(err) };
	}
});

ipcMain.on("show-error", (e, title, message) => {
	dialog.showErrorBox(title, message);
});

ipcMain.on("file-loaded", (e, file_path) => {
	if (typeof file_path === "string" && path.isAbsolute(file_path)) {
		loaded_file_path = file_path;
	}
});

ipcMain.on("show-file", show_file);

ipcMain.on("exit-fullscreen", e => {
	let sender_window = BrowserWindow.fromWebContents(e.sender);
	if (sender_window && sender_window.isFullScreen()) sender_window.setFullScreen(false);
});

app.whenReady().then(() => {
	build_menu();
	create_window();
});
app.on("window-all-closed", () => app.quit());
