#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/* Tauri host for the WinBolo Replay Viewer: the window, menu, dialog and
 * file plumbing of the Electron main.js, done in Rust. The page never sees
 * Tauri directly: tauri_api.js wraps the commands below into the window.api
 * that renderer.js expects from the Electron preload script.
 *
 * Every file the page reads was chosen by the user through this process (a
 * dialog, a drop, or the command line): the page asks for a replay by the id
 * this process gave it rather than naming a path, so no command reads or
 * writes an arbitrary path handed over from the web side. */

use std::{
	fs,
	path::{Path, PathBuf},
	sync::Mutex,
};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{
	ipc::{InvokeBody, Request},
	ipc::Response,
	menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
	AppHandle, DragDropEvent, Emitter, Manager, WebviewWindow, WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

/* A replay is a few MB compressed; refuse absurdities before reading them. */
const MAX_LOG_BYTES: u64 = 256 << 20;

const SETTINGS_FILE: &str = "settings.json";
const LAST_OPEN_DIRECTORY: &str = "last_open_directory";
const LAST_SAVE_DIRECTORY: &str = "last_save_directory";

/* A replay this process read, waiting for the page to take it. Each is
 * stashed under its own id, and the page asks for bytes by the id it was
 * told of, so two replays arriving while the page is busy can't swap. */
struct PendingLog {
	id: u64,
	path: PathBuf,
	data: Vec<u8>,
}

/* A page that never collects (none listening yet) can't hoard replays. */
const MAX_PENDING_LOGS: usize = 4;

#[derive(Default)]
struct AppState {
	pending_logs: Vec<PendingLog>,
	next_log_id: u64,
	loaded_file_path: Option<PathBuf>,
}

type Shared = Mutex<AppState>;

fn lock(app: &AppHandle) -> std::sync::MutexGuard<'_, AppState> {
	app.state::<Shared>().inner().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/* The shape main.js returned from its dialogs, which the page still expects. */
#[derive(Serialize)]
struct FileResult {
	canceled: bool,
	#[serde(skip_serializing_if = "Option::is_none")]
	id: Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	path: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	error: Option<String>,
}

impl FileResult {
	fn canceled() -> Self {
		FileResult { canceled: true, id: None, path: None, error: None }
	}
	fn error(err: impl ToString) -> Self {
		FileResult { canceled: true, id: None, path: None, error: Some(err.to_string()) }
	}
	fn ok(path: &Path) -> Self {
		FileResult { canceled: false, id: None, path: Some(path_string(path)), error: None }
	}
	/* an opened replay: the id its bytes are taken by */
	fn opened(id: u64, path: &Path) -> Self {
		FileResult { id: Some(id), ..FileResult::ok(path) }
	}
}

/* A replay waiting for the page: the id its bytes are taken by, and its path. */
#[derive(Clone, Serialize)]
struct LoadLog {
	id: u64,
	path: String,
}

impl LoadLog {
	fn of(log: &PendingLog) -> Self {
		LoadLog { id: log.id, path: path_string(&log.path) }
	}
}

fn path_string(path: &Path) -> String {
	path.to_string_lossy().into_owned()
}

/* ---------- settings: the last directories the dialogs used ---------- */

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
	app.path().app_data_dir().ok().map(|dir| dir.join(SETTINGS_FILE))
}

fn read_settings(app: &AppHandle) -> Map<String, Value> {
	settings_path(app)
		.and_then(|path| fs::read_to_string(path).ok())
		.and_then(|text| serde_json::from_str::<Value>(&text).ok())
		.and_then(|value| match value {
			Value::Object(map) => Some(map),
			_ => None,
		})
		.unwrap_or_default()
}

fn write_settings(app: &AppHandle, settings: &Map<String, Value>) {
	/* preferences must never prevent opening a replay: every failure is ignored */
	let Some(path) = settings_path(app) else { return };
	if let Some(dir) = path.parent() {
		let _ = fs::create_dir_all(dir);
	}
	if let Ok(mut text) = serde_json::to_string_pretty(settings) {
		text.push('\n');
		let _ = fs::write(path, text);
	}
}

fn last_directory(app: &AppHandle, key: &str) -> Option<PathBuf> {
	let settings = read_settings(app);
	let dir = PathBuf::from(settings.get(key)?.as_str()?);
	if dir.is_dir() { Some(dir) } else { None }
}

fn remember_directory(app: &AppHandle, key: &str, file_path: &Path) {
	let Some(dir) = file_path.parent() else { return };
	let mut settings = read_settings(app);
	settings.insert(key.to_string(), Value::String(path_string(dir)));
	write_settings(app, &settings);
}

/* ---------- replays ---------- */

fn read_log(path: &Path) -> Result<Vec<u8>, String> {
	let size = fs::metadata(path).map_err(|err| err.to_string())?.len();
	if size > MAX_LOG_BYTES {
		return Err(format!("{} is {} bytes; not a WinBolo replay.", path.display(), size));
	}
	fs::read(path).map_err(|err| err.to_string())
}

/* Hold a replay for the page under a fresh id, evicting the oldest held
 * once there are too many. */
fn stash_log(app: &AppHandle, path: PathBuf, data: Vec<u8>) -> u64 {
	let mut state = lock(app);
	state.next_log_id += 1;
	let id = state.next_log_id;
	state.pending_logs.push(PendingLog { id, path, data });
	while state.pending_logs.len() > MAX_PENDING_LOGS {
		state.pending_logs.remove(0);
	}
	id
}

/* A replay the user handed us outside the page (dropped on the window):
 * read it here, then tell the page there is one to take. */
fn offer_log(app: &AppHandle, path: &Path) {
	match read_log(path) {
		Ok(data) => {
			let id = stash_log(app, path.to_path_buf(), data);
			let _ = app.emit("load-log", LoadLog { id, path: path_string(path) });
		}
		Err(err) => error_box(app, "Could not open replay", &err),
	}
}

fn find_cli_log() -> Option<PathBuf> {
	std::env::args_os()
		.skip(1)
		.map(PathBuf::from)
		.filter(|arg| !arg.to_string_lossy().starts_with('-'))
		.find(|arg| arg.is_file())
		.map(|arg| std::path::absolute(&arg).unwrap_or(arg))
}

/* ---------- dialogs and the window ---------- */

fn error_box(app: &AppHandle, title: &str, message: &str) {
	let mut dialog = app.dialog().message(message).title(title).kind(MessageDialogKind::Error);
	if let Some(window) = app.get_webview_window("main") {
		dialog = dialog.parent(&window);
	}
	dialog.show(|_| {});
}

fn reveal_loaded_file(app: &AppHandle) {
	let path = lock(app).loaded_file_path.clone();
	if let Some(path) = path {
		let _ = app.opener().reveal_item_in_dir(path);
	}
}

/* Fullscreen hides the menu bar, as Electron's does by itself. On Windows
 * the menu is part of the window frame rather than of the page, so a
 * borderless fullscreen window keeps drawing it across the top of the
 * screen unless it is detached; hidden, the page gets the whole monitor. */
fn set_window_fullscreen(window: &WebviewWindow, on: bool) {
	if on {
		let _ = window.hide_menu();
		let _ = window.set_fullscreen(true);
	} else {
		let _ = window.set_fullscreen(false);
		let _ = window.show_menu();
	}
}

fn toggle_window_fullscreen(window: &WebviewWindow) {
	let now = window.is_fullscreen().unwrap_or(false);
	set_window_fullscreen(window, !now);
}

/* ---------- pieces of a binary request ---------- */

fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
	match request.body() {
		InvokeBody::Raw(bytes) => Ok(bytes.as_slice()),
		InvokeBody::Json(_) => Err("expected a binary body".to_string()),
	}
}

fn header(request: &Request<'_>, name: &str) -> Option<String> {
	request.headers().get(name).and_then(|value| value.to_str().ok()).map(String::from)
}

/* Map names can hold any character, and HTTP headers cannot, so the page
 * sends the file name percent-encoded (encodeURIComponent). */
fn percent_decode(text: &str) -> String {
	fn hex(byte: u8) -> Option<u8> {
		(byte as char).to_digit(16).map(|digit| digit as u8)
	}
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%' && i + 2 < bytes.len() {
			if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
				out.push(high * 16 + low);
				i += 3;
				continue;
			}
		}
		out.push(bytes[i]);
		i += 1;
	}
	String::from_utf8_lossy(&out).into_owned()
}

/* ---------- commands ---------- */

/* Dialogs block until dismissed, so the commands that show one are async:
 * Tauri runs those off the main thread, where a modal dialog can spin. */

#[tauri::command]
async fn open_log(app: AppHandle, window: WebviewWindow) -> FileResult {
	let mut dialog = app
		.dialog()
		.file()
		.set_parent(&window)
		.set_title("Open replay")
		.add_filter("WinBolo replays", &["wbv", "dat"])
		.add_filter("All files", &["*"]);
	if let Some(dir) = last_directory(&app, LAST_OPEN_DIRECTORY) {
		dialog = dialog.set_directory(dir);
	}
	let Some(picked) = dialog.blocking_pick_file() else { return FileResult::canceled() };
	let path = match picked.simplified().into_path() {
		Ok(path) => path,
		Err(err) => return FileResult::error(err),
	};
	match read_log(&path) {
		Ok(data) => {
			remember_directory(&app, LAST_OPEN_DIRECTORY, &path);
			let id = stash_log(&app, path.clone(), data);
			FileResult::opened(id, &path)
		}
		Err(err) => FileResult::error(err),
	}
}

/* The bytes of the replay the page was told of under this id, as a raw
 * response (an ArrayBuffer on the other side) rather than a JSON array of
 * numbers. Each replay is handed over once; an id no longer held (taken
 * already, or evicted) is an error. */
#[tauri::command]
fn take_log_bytes(app: AppHandle, id: u64) -> Result<Response, String> {
	let mut state = lock(&app);
	let index = state.pending_logs.iter().position(|log| log.id == id).ok_or("that replay is no longer waiting")?;
	Ok(Response::new(state.pending_logs.remove(index).data))
}

/* At startup: the replays waiting already, in the order they arrived (one
 * named on the command line, and any dropped before the page listened). */
#[tauri::command]
fn pending_logs(app: AppHandle) -> Vec<LoadLog> {
	lock(&app).pending_logs.iter().map(LoadLog::of).collect()
}

#[tauri::command(rename_all = "snake_case")]
async fn save_map(app: AppHandle, window: WebviewWindow, request: Request<'_>) -> Result<FileResult, String> {
	let default_name = header(&request, "x-name").map(|name| percent_decode(&name)).unwrap_or_else(|| "map.map".to_string());
	let bytes = raw_body(&request)?.to_vec();
	let mut dialog = app
		.dialog()
		.file()
		.set_parent(&window)
		.set_title("Save initial map")
		.add_filter("Bolo maps", &["map", "bmap"])
		.set_file_name(&default_name);
	if let Some(dir) = last_directory(&app, LAST_SAVE_DIRECTORY) {
		dialog = dialog.set_directory(dir);
	}
	let Some(picked) = dialog.blocking_save_file() else { return Ok(FileResult::canceled()) };
	let path = match picked.simplified().into_path() {
		Ok(path) => path,
		Err(err) => return Ok(FileResult::error(err)),
	};
	Ok(match fs::write(&path, &bytes) {
		Ok(()) => {
			remember_directory(&app, LAST_SAVE_DIRECTORY, &path);
			FileResult::ok(&path)
		}
		Err(err) => FileResult::error(err),
	})
}

#[tauri::command]
fn show_error(app: AppHandle, title: String, message: String) {
	error_box(&app, &title, &message);
}

#[tauri::command]
fn file_loaded(app: AppHandle, window: WebviewWindow, path: String, title: String) {
	/* the page sets document.title, which the native window does not follow */
	let _ = window.set_title(&title);
	let path = PathBuf::from(path);
	if path.is_absolute() {
		lock(&app).loaded_file_path = Some(path);
	}
}

#[tauri::command]
fn show_file(app: AppHandle) {
	reveal_loaded_file(&app);
}

#[tauri::command]
fn exit_fullscreen(window: WebviewWindow) {
	if window.is_fullscreen().unwrap_or(false) {
		set_window_fullscreen(&window, false);
	}
}

#[tauri::command]
fn toggle_fullscreen(window: WebviewWindow) {
	toggle_window_fullscreen(&window);
}

/* ---------- the menu ---------- */

/* The menu registers no keyboard accelerators: the page handles every
 * shortcut itself (as its web version already does), which keeps one key
 * from acting twice. The shortcut shown beside each item is just text:
 * Windows draws whatever follows a tab in a menu label right-aligned, in
 * the accelerator column. */
fn menu_label(text: &str, hint: &str) -> String {
	if hint.is_empty() { text.to_string() } else { format!("{text}\t{hint}") }
}

fn item(app: &AppHandle, id: &str, text: &str, hint: &str) -> tauri::Result<MenuItem<Wry>> {
	MenuItem::with_id(app, id, menu_label(text, hint), true, None::<&str>)
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
	let file = Submenu::with_items(app, "&File", true, &[
		&item(app, "open", "Open replay…", "Ctrl+O")?,
		&PredefinedMenuItem::separator(app)?,
		&item(app, "show-file", "Show file", "")?,
		&item(app, "save-map", "Save initial map…", "Ctrl+S")?,
		&PredefinedMenuItem::separator(app)?,
		&PredefinedMenuItem::quit(app, Some("Exit"))?,
	])?;
	let playback = Submenu::with_items(app, "&Playback", true, &[
		&item(app, "play-pause", "Play / Pause", "Space")?,
		&item(app, "previous-change", "Previous Change", "Up")?,
		&item(app, "next-change", "Next Change", "Down")?,
		&item(app, "go-to-beginning", "Go to Beginning", "Home")?,
		&item(app, "go-to-end", "Go to End", "End")?,
	])?;
	let view = Submenu::with_items(app, "&View", true, &[
		&item(app, "zoom-in", "Zoom in", "Ctrl+=")?,
		&item(app, "zoom-out", "Zoom out", "Ctrl+-")?,
		&item(app, "centre-map", "Centre map", "Ctrl+0")?,
		&PredefinedMenuItem::separator(app)?,
		&item(app, "toggle-player-lock", "Toggle player lock", "Ctrl+L")?,
		&PredefinedMenuItem::separator(app)?,
		&item(app, "toggle-obj-sprites", "Toggle simple graphics", "Ctrl+G")?,
		&item(app, "toggle-simple-terrain", "Toggle simple terrain", "Ctrl+T")?,
		&item(app, "toggle-lgm-sprites", "Toggle simple LGM", "Ctrl+M")?,
		&item(app, "toggle-big-shots", "Toggle big shots", "Ctrl+B")?,
		&item(app, "toggle-neutral-pill-colour", "Toggle neutral pill colour", "Ctrl+N")?,
		&PredefinedMenuItem::separator(app)?,
		&item(app, "toggle-event-messages", "Toggle event messages", "Ctrl+E")?,
		&item(app, "toggle-pregame-messages", "Toggle pre-game messages", "Ctrl+P")?,
		&PredefinedMenuItem::separator(app)?,
		&item(app, "toggle-fullscreen", "Toggle Full Screen", "F11")?,
	])?;
	let debug = Submenu::with_items(app, "&Debug", true, &[
		&item(app, "toggle-coordinate-debug", "Toggle debug coordinates", "Ctrl+D")?,
		&item(app, "toggle-pillbox-ids", "Toggle pillbox IDs", "Ctrl+I")?,
		&PredefinedMenuItem::separator(app)?,
		&item(app, "devtools", "Dev tools", "")?,
	])?;
	let version = MenuItem::with_id(app, "version", app.package_info().version.to_string(), false, None::<&str>)?;
	Menu::with_items(app, &[&file, &playback, &view, &debug, &version])
}

/* The few items the host handles itself; the rest go to the page as the
 * same command names main.js sends. */
fn handle_menu(app: &AppHandle, id: &str) {
	match id {
		"show-file" => reveal_loaded_file(app),
		"toggle-fullscreen" => {
			if let Some(window) = app.get_webview_window("main") {
				toggle_window_fullscreen(&window);
			}
		}
		"devtools" => {
			if let Some(window) = app.get_webview_window("main") {
				window.open_devtools();
			}
		}
		"version" => {}
		cmd => {
			let _ = app.emit("menu-cmd", cmd.to_string());
		}
	}
}

fn main() {
	tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_opener::init())
		.manage(Shared::default())
		.invoke_handler(tauri::generate_handler![
			open_log,
			take_log_bytes,
			pending_logs,
			save_map,
			show_error,
			file_loaded,
			show_file,
			exit_fullscreen,
			toggle_fullscreen,
		])
		.setup(|app| {
			let handle = app.handle().clone();
			app.set_menu(build_menu(&handle)?)?;
			app.on_menu_event(|app, event| handle_menu(app, event.id().as_ref()));

			if let Some(path) = find_cli_log() {
				match read_log(&path) {
					Ok(data) => {
						stash_log(&handle, path, data); /* listed to the page by pending_logs */
					}
					Err(err) => error_box(&handle, "Could not open replay", &err),
				}
			}

			let window = app.get_webview_window("main").expect("the main window is declared in tauri.conf.json");
			window.on_window_event(move |event| {
				if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
					if let Some(path) = paths.first() {
						offer_log(&handle, path);
					}
				}
			});
			Ok(())
		})
		.run(tauri::generate_context!())
		.expect("error while running the WinBolo Replay Viewer");
}
