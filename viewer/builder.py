ELECTRON_VERSION = "43.4.1"

zips = {
	"windows": "electron_zipped/electron-v{}-win32-x64.zip".format(ELECTRON_VERSION),
	"linux": "electron_zipped/electron-v{}-linux-x64.zip".format(ELECTRON_VERSION),
	"mac-arm64": "electron_zipped/electron-v{}-darwin-arm64.zip".format(ELECTRON_VERSION),
	"mac-x64": "electron_zipped/electron-v{}-darwin-x64.zip".format(ELECTRON_VERSION),
}

MAC_DISPLAY_NAME = "WinBolo Replay Viewer"
MAC_BUNDLE_ID = "com.rooklift.winbolo-replay-viewer"


# To build the WinBolo Replay Viewer: (for info see https://electronjs.org/docs/tutorial/application-distribution)
#
# Obtain the appropriate Electron asset named above, from https://github.com/electron/electron/releases
# Create a folder called ./electron_zipped and place the Electron asset in it
# Run ./builder.py from this directory (viewer/)
#
# Mac builds are best made on a Mac (or CI Mac, see .github/workflows/release-builds.yml) because the
# .app must be re-signed after we modify it; without codesign the result won't run on Apple Silicon.
# The finished .app must be distributed in a way that preserves symlinks, e.g.
# ditto -c -k --keepParent "WinBolo Replay Viewer.app" viewer.zip


import json, os, plistlib, shutil, subprocess, sys, zipfile

if os.environ.get("BUILDER_ANY_BRANCH") != "1":		# CI checkouts are a detached HEAD, so the workflow sets this
	try:
		branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, encoding="utf8", check=True).stdout.strip()
	except (OSError, subprocess.CalledProcessError):
		sys.exit("builder.py: cannot determine the git branch; refusing to build.")
	if branch != "main":
		sys.exit("builder.py: on branch \"{}\", not \"main\"; refusing to build.".format(branch))

with open("package.json") as f:
	pj = json.load(f)
	name = pj["name"]
	version = pj["version"]

useful_files = [file for file in os.listdir() if file.endswith(".js") or file.endswith(".html") or file.endswith(".css") or file == "package.json"]
folders = ["sprites"]


def copy_app_files(build_app_dir):
	os.makedirs(build_app_dir)
	for file in useful_files:
		shutil.copy(file, build_app_dir)
	for folder in folders:
		shutil.copytree(folder, os.path.join(build_app_dir, folder))


def build_mac(value, build_dir):

	# Python's zipfile drops the symlinks and permissions inside the .app, which breaks it,
	# so extract with ditto (macOS) or unzip (elsewhere), both of which preserve them.

	os.makedirs(build_dir)
	print("Extracting for mac...")
	if shutil.which("ditto"):
		subprocess.run(["ditto", "-x", "-k", value, build_dir], check=True)
	else:
		subprocess.run(["unzip", "-q", value, "-d", build_dir], check=True)

	app_bundle = os.path.join(build_dir, MAC_DISPLAY_NAME + ".app")
	os.rename(os.path.join(build_dir, "Electron.app"), app_bundle)
	copy_app_files(os.path.join(app_bundle, "Contents/Resources/app"))

	plist_path = os.path.join(app_bundle, "Contents/Info.plist")
	with open(plist_path, "rb") as f:
		plist = plistlib.load(f)
	plist["CFBundleName"] = MAC_DISPLAY_NAME
	plist["CFBundleDisplayName"] = MAC_DISPLAY_NAME
	plist["CFBundleIdentifier"] = MAC_BUNDLE_ID
	plist["CFBundleShortVersionString"] = version
	plist["CFBundleVersion"] = version
	with open(plist_path, "wb") as f:
		plistlib.dump(plist, f)

	# Our edits invalidate the ad-hoc signature Electron ships with, and Apple Silicon
	# refuses to launch anything whose signature is invalid, so re-sign (ad-hoc).

	if shutil.which("codesign"):
		print("Re-signing (ad-hoc)...")
		subprocess.run(["codesign", "--force", "--deep", "--sign", "-", app_bundle], check=True)
	else:
		print("WARNING: codesign not available; the .app must be ad-hoc signed on a Mac before it will run.")


for key, value in zips.items():
	if not os.path.exists(value):
		continue
	build_dir = "dist/{}-{}-{}".format(name, version, key)

	if key.startswith("mac"):
		build_mac(value, build_dir)
		continue

	copy_app_files(os.path.join(build_dir, "resources/app"))
	print("Extracting for {}...".format(key))
	if key == "linux" and shutil.which("unzip"):
		# Python's zipfile drops the executable bit on the electron binary; unzip keeps it.
		subprocess.run(["unzip", "-q", value, "-d", build_dir], check=True)
	else:
		z = zipfile.ZipFile(value, "r")
		z.extractall(build_dir)
		z.close()
	if os.path.exists(os.path.join(build_dir, "electron.exe")):
		os.rename(os.path.join(build_dir, "electron.exe"), os.path.join(build_dir, "{}.exe".format(name)))
	if os.path.exists(os.path.join(build_dir, "electron")):
		os.rename(os.path.join(build_dir, "electron"), os.path.join(build_dir, name))

	# Remove unneeded locale files
	locales_dir = os.path.join(build_dir, "locales")
	if os.path.exists(locales_dir):
		for file in os.listdir(locales_dir):
			if file.endswith(".pak") and file != "en-US.pak":
				os.remove(os.path.join(locales_dir, file))

	# We could and maybe should...
	"""
	if key == "windows":
		electron_exe = os.path.join(build_dir, "{}.exe".format(name))
		print("Running rcedit...")
		subprocess.run([
			"rcedit-x64.exe",
			electron_exe,
			"--set-version-string", "FileDescription", "WinBolo Replay Viewer",
			"--set-version-string", "ProductName", "WinBolo Replay Viewer",
			"--set-version-string", "LegalCopyright", "Copyright 2026 Rooklift",
			"--set-file-version", version,
			"--set-product-version", version
		], check=True)
	"""
