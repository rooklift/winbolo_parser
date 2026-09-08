# Draws the app icon from the viewer's own friendly-tank sprite: the 16x16
# pixel art scaled up (nearest neighbour, so it stays crisp) on the viewer's
# dark background, written as icons/icon.ico (every size Windows asks for)
# and icons/icon.png (256x256, for the other platforms one day).
#
# Dependency-free: the sprite is decoded and the images encoded by hand,
# because a PNG whose rows are unfiltered 8-bit palette indices is easy.

import os, struct, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SPRITE = os.path.join(HERE, "..", "sprites", "objects", "tank_good_04.png")
BACKGROUND = (0x10, 0x13, 0x1a)
SIZES = [16, 24, 32, 48, 64, 128, 256]


def read_sprite(path):
	data = open(path, "rb").read()
	palette, alpha, pixels, width, height = None, None, None, 0, 0
	at = 8
	while at < len(data):
		length, = struct.unpack(">I", data[at:at + 4])
		kind = data[at + 4:at + 8]
		body = data[at + 8:at + 8 + length]
		if kind == b"IHDR":
			width, height, depth, colour_type = struct.unpack(">IIBB", body[:10])
			if depth != 8 or colour_type != 3:
				raise SystemExit("make_icon.py: the sprite must be an 8-bit palette PNG")
		elif kind == b"PLTE":
			palette = [tuple(body[i:i + 3]) for i in range(0, length, 3)]
		elif kind == b"tRNS":
			alpha = list(body)
		elif kind == b"IDAT":
			raw = zlib.decompress(body)
			stride = width + 1
			pixels = []
			for y in range(height):
				if raw[y * stride] != 0:
					raise SystemExit("make_icon.py: the sprite uses PNG row filters; expected none")
				pixels.append(list(raw[y * stride + 1:y * stride + 1 + width]))
		at += 12 + length
	def rgba(index):
		r, g, b = palette[index]
		a = alpha[index] if alpha and index < len(alpha) else 255
		return (r, g, b, a)
	return [[rgba(index) for index in row] for row in pixels]


def render(sprite, size):
	"""The sprite scaled to about three quarters of the icon, centred on a
	rounded dark square; at 16 px it is the sprite itself, transparent."""
	n = len(sprite)
	if size <= n:
		return [[px for px in row] for row in sprite]
	scale = max(1, (size * 3 // 4) // n)
	margin = (size - n * scale) // 2
	radius = size // 8
	image = []
	for y in range(size):
		row = []
		for x in range(size):
			# rounded corners: outside the corner circles is transparent
			cx = min(max(x, radius), size - 1 - radius)
			cy = min(max(y, radius), size - 1 - radius)
			inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius
			px = BACKGROUND + (255,) if inside else (0, 0, 0, 0)
			sx, sy = (x - margin) // scale, (y - margin) // scale
			if 0 <= sx < n and 0 <= sy < n and sprite[sy][sx][3] != 0:
				px = sprite[sy][sx]
			row.append(px)
		image.append(row)
	return image


def png_bytes(image):
	size = len(image)
	def chunk(kind, body):
		return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff)
	raw = b"".join(b"\0" + bytes(c for px in row for c in px) for row in image)
	return (b"\x89PNG\r\n\x1a\n"
		+ chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
		+ chunk(b"IDAT", zlib.compress(raw, 9))
		+ chunk(b"IEND", b""))


def bmp_bytes(image):
	"""An ICO's classic DIB entry: BITMAPINFOHEADER, then BGRA rows bottom-up,
	then the 1-bit AND mask (rows padded to 32 bits), also bottom-up."""
	size = len(image)
	header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
	xor = b"".join(bytes(c for px in row for c in (px[2], px[1], px[0], px[3])) for row in reversed(image))
	mask_stride = ((size + 31) // 32) * 4
	mask = b""
	for row in reversed(image):
		bits = 0
		for x, px in enumerate(row):
			if px[3] == 0:
				bits |= 1 << (mask_stride * 8 - 1 - x)
		mask += bits.to_bytes(mask_stride, "big")
	return header + xor + mask


def ico_bytes(images):
	entries, blobs = b"", b""
	offset = 6 + 16 * len(images)
	for image in images:
		size = len(image)
		blob = png_bytes(image) if size >= 256 else bmp_bytes(image)
		entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(blob), offset + len(blobs))
		blobs += blob
	return struct.pack("<HHH", 0, 1, len(images)) + entries + blobs


sprite = read_sprite(SPRITE)
images = [render(sprite, size) for size in SIZES]
os.makedirs(os.path.join(HERE, "icons"), exist_ok=True)
with open(os.path.join(HERE, "icons", "icon.ico"), "wb") as f:
	f.write(ico_bytes(images))
with open(os.path.join(HERE, "icons", "icon.png"), "wb") as f:
	f.write(png_bytes(images[-1]))
print("wrote icons/icon.ico ({}) and icons/icon.png".format(", ".join(str(s) for s in SIZES)))
