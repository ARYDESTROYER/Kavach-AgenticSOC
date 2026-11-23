"""Structural validation and metadata stripping for case screenshots (Round 15 SPEC
D5.3, D5.4; storage map §7.3).

Pure standard library (``struct``, ``zlib``, ``hashlib``): no image library is added,
and the server never decodes pixels. What it does instead, for each accepted format:

* **PNG**: the signature, a chunk walk with every CRC checked, ``IHDR`` first (its
  width, height, bit depth and colour type checked), consecutive ``IDAT`` chunks, a
  ``PLTE`` for a palette image, ``IEND`` last and **no byte after it**. Kept chunks:
  ``IHDR``, ``PLTE``, ``IDAT``, ``IEND``, ``tRNS``, ``gAMA``, ``cHRM``, ``sRGB``,
  ``sBIT``, ``pHYs``, ``bKGD`` and ``iCCP`` (at most :data:`MAX_ICC_BYTES`). Every
  other ancillary chunk is dropped (``eXIf``, ``tEXt``, ``zTXt``, ``iTXt``, ``tIME``,
  and ``acTL``, ``fcTL``, ``fdAT``, which turns an animated PNG into its still image).
  An unknown critical chunk is refused.
* **JPEG**: ``SOI``, then a marker walk. Kept: ``APP0`` (``JFIF`` only, rewritten
  without its embedded thumbnail), ``APP2`` only when it carries ``ICC_PROFILE`` (all
  of it at most :data:`MAX_ICC_BYTES`, else every ICC segment is dropped), ``APP14``
  (``Adobe``), ``DQT``, ``DHT``, ``DAC``, ``DRI``, ``DNL``, one ``SOFn`` (its
  dimensions), every ``SOS`` with its entropy-coded data, and ``EOI``. Dropped:
  ``APP1`` (Exif and XMP), every other ``APPn`` (IPTC included) and ``COM``. A second
  frame, a hierarchical or JPEG-LS marker, a stray restart marker, a reserved marker
  and any byte after ``EOI`` are refused. EXIF orientation is lost for a direct API
  upload; the Console's uploads are already orientation-normalised by the canvas.
* **WebP**: ``RIFF<size>WEBP`` with the size matching the data exactly, a chunk walk.
  Simple files keep their one ``VP8 `` or ``VP8L`` chunk. Extended files (``VP8X``)
  keep ``VP8X`` (its EXIF and XMP flags cleared, and its ICC flag when the profile is
  dropped), ``ICCP``, ``ALPH`` and the image chunk; ``EXIF``, ``XMP `` and unknown
  chunks are dropped; an animated file (the animation flag, ``ANIM`` or ``ANMF``) is
  refused. The RIFF size is recomputed.

Dimensions are read from the headers only (``IHDR``, ``SOFn``, ``VP8X``, ``VP8 ``,
``VP8L``) and capped at :data:`MAX_SIDE_PX` a side and :data:`MAX_PIXELS` in all, so a
decompression bomb never reaches a viewer's browser. The size cap applies to the
stored (stripped) bytes, whose SHA-256 is the file's content hash. Everything else
(SVG, GIF, BMP, TIFF, HEIC, ICO, PDF, a polyglot with trailing data) is refused.

Limitation, stated in the docs: a crafted image that is structurally valid but aimed
at a browser decoder is not detected here. The type allowlist, this structure check,
the dimension caps, uploads by signed-in case collaborators only, the audit row and
the strict content headers of the serving route are the mitigations.

Never imports the decision core (#3) and never reaches a model (#9).
"""

from __future__ import annotations

import hashlib
import struct
import zlib
from dataclasses import dataclass
from typing import Callable

PNG = "png"
JPEG = "jpeg"
WEBP = "webp"

#: The served ``Content-Type`` of each accepted kind.
MIME_TYPES: dict[str, str] = {PNG: "image/png", JPEG: "image/jpeg", WEBP: "image/webp"}
#: The file extension of each kind in a generated download name.
EXTENSIONS: dict[str, str] = {PNG: "png", JPEG: "jpg", WEBP: "webp"}
#: Declared types a client may send, mapped onto a kind.
_DECLARED: dict[str, str] = {
    "png": PNG, "image/png": PNG,
    "jpeg": JPEG, "jpg": JPEG, "image/jpeg": JPEG, "image/jpg": JPEG, "image/pjpeg": JPEG,
    "webp": WEBP, "image/webp": WEBP,
}

#: The stored size bound of one screenshot (after stripping), 2 MiB.
MAX_IMAGE_BYTES = 2 * 1024 * 1024
#: The stored size bound of one thumbnail, 48 KiB.
MAX_THUMBNAIL_BYTES = 48 * 1024
#: The longest side, in pixels.
MAX_SIDE_PX = 8192
#: The most pixels in all (40 megapixels).
MAX_PIXELS = 40_000_000
#: The largest colour profile kept (PNG ``iCCP``, JPEG ``APP2``, WebP ``ICCP``).
MAX_ICC_BYTES = 64 * 1024

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PNG_CRITICAL = frozenset({b"IHDR", b"PLTE", b"IDAT", b"IEND"})
_PNG_KEEP = frozenset({
    b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"sBIT",
    b"pHYs", b"bKGD", b"iCCP",
})
#: PNG colour type -> the bit depths it allows (PNG specification, table 11.1).
_PNG_DEPTHS: dict[int, frozenset[int]] = {
    0: frozenset({1, 2, 4, 8, 16}),
    2: frozenset({8, 16}),
    3: frozenset({1, 2, 4, 8}),
    4: frozenset({8, 16}),
    6: frozenset({8, 16}),
}

#: JPEG start-of-frame markers this module accepts (baseline, extended, progressive,
#: lossless, Huffman and arithmetic; never the hierarchical ``DHP``/``EXP`` pair).
_JPEG_SOF = frozenset({0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF})
#: Table and control segments kept verbatim: DHT, DAC, DQT, DRI, DNL.
_JPEG_TABLES = frozenset({0xC4, 0xCC, 0xDB, 0xDD, 0xDC})

_WEBP_FLAG_ANIMATION = 0x02
_WEBP_FLAG_XMP = 0x04
_WEBP_FLAG_EXIF = 0x08
_WEBP_FLAG_ICC = 0x20


class ImageRejected(ValueError):
    """An upload this module refuses. ``code`` is the API error code, ``status`` its
    HTTP status and ``message`` plain Console copy. Neither ever quotes the upload."""

    def __init__(self, code: str, message: str, *, status: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _invalid(detail: str) -> ImageRejected:
    return ImageRejected(
        "case_files_invalid_image",
        f"The image file is damaged or not a plain still image ({detail}).",
        status=422,
    )


def _unsupported() -> ImageRejected:
    return ImageRejected(
        "case_files_unsupported_type",
        "Only PNG, JPEG and WebP images are accepted.",
        status=415,
    )


@dataclass(frozen=True)
class ValidatedImage:
    """A screenshot that passed validation: its kind, the stripped bytes that are
    stored and served, and the dimensions read from its headers."""

    kind: str
    data: bytes
    width: int
    height: int

    @property
    def mime(self) -> str:
        return MIME_TYPES[self.kind]

    @property
    def size(self) -> int:
        return len(self.data)

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


def sniff(data: bytes) -> str | None:
    """The kind of ``data`` by its magic bytes (``png``, ``jpeg``, ``webp``), or
    ``None`` for anything else."""
    if data.startswith(_PNG_SIGNATURE):
        return PNG
    if data[:3] == b"\xff\xd8\xff":
        return JPEG
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return WEBP
    return None


def declared_kind(declared: str | None) -> str | None:
    """The kind a client-declared type names, ``None`` when it names none of the
    accepted ones (an unknown declared type is refused as unsupported)."""
    if declared is None:
        return None
    return _DECLARED.get(declared.strip().lower())


def validate_image(
    data: bytes,
    *,
    declared: str | None = None,
    max_bytes: int = MAX_IMAGE_BYTES,
) -> ValidatedImage:
    """Validate ``data`` and return its stripped form, or raise :class:`ImageRejected`.

    ``declared`` is the client's type (``image/png`` and so on); when given it must
    name the kind the magic bytes show (else ``415``). ``max_bytes`` bounds the
    stripped bytes (``413 case_files_too_large``)."""
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise _invalid("empty file")
    data = bytes(data)
    kind = sniff(data)
    if kind is None:
        raise _unsupported()
    if declared is not None:
        want = declared_kind(declared)
        if want is None or want != kind:
            raise ImageRejected(
                "case_files_unsupported_type",
                "The file's type does not match its contents. Only PNG, JPEG and WebP images are accepted.",
                status=415,
            )
    parser: Callable[[bytes], tuple[bytes, int, int]] = {
        PNG: _strip_png, JPEG: _strip_jpeg, WEBP: _strip_webp,
    }[kind]
    stripped, width, height = parser(data)
    _check_dimensions(width, height)
    if len(stripped) > max_bytes:
        raise ImageRejected(
            "case_files_too_large",
            f"The image is larger than {_size_label(max_bytes)} after its metadata is removed.",
            status=413,
        )
    return ValidatedImage(kind=kind, data=stripped, width=width, height=height)


def _size_label(n: int) -> str:
    if n >= 1024 * 1024 and n % (1024 * 1024) == 0:
        return f"{n // (1024 * 1024):,} MiB"
    return f"{n // 1024:,} KiB"


def _check_dimensions(width: int, height: int) -> None:
    if width <= 0 or height <= 0:
        raise ImageRejected(
            "case_files_dimensions", "The image has no width or height.", status=422,
        )
    if width > MAX_SIDE_PX or height > MAX_SIDE_PX or width * height > MAX_PIXELS:
        raise ImageRejected(
            "case_files_dimensions",
            f"The image is too large: at most {MAX_SIDE_PX:,} pixels a side and "
            f"{MAX_PIXELS // 1_000_000:,} megapixels in all.",
            status=422,
        )


# --------------------------------------------------------------------------- #
# PNG
# --------------------------------------------------------------------------- #
def _strip_png(data: bytes) -> tuple[bytes, int, int]:
    n = len(data)
    pos = len(_PNG_SIGNATURE)
    out: list[bytes] = [_PNG_SIGNATURE]
    width = height = 0
    color_type = -1
    seen_ihdr = seen_plte = seen_idat = seen_iend = seen_iccp = False
    prev_idat = False
    while pos < n:
        if n - pos < 12:
            raise _invalid("truncated chunk")
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        if length > 0x7FFFFFFF:
            raise _invalid("chunk length out of range")
        ctype = data[pos + 4:pos + 8]
        if not all(65 <= b <= 90 or 97 <= b <= 122 for b in ctype):
            raise _invalid("chunk type is not four letters")
        body_end = pos + 8 + length
        end = body_end + 4
        if end > n:
            raise _invalid("truncated chunk")
        body = data[pos + 8:body_end]
        (crc,) = struct.unpack(">I", data[body_end:end])
        if zlib.crc32(ctype + body) & 0xFFFFFFFF != crc:
            raise _invalid("chunk checksum mismatch")
        chunk = data[pos:end]
        pos = end
        if not seen_ihdr and ctype != b"IHDR":
            raise _invalid("the first chunk is not IHDR")
        if ctype == b"IHDR":
            if seen_ihdr:
                raise _invalid("more than one IHDR")
            if length != 13:
                raise _invalid("IHDR has the wrong length")
            width, height, depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", body,
            )
            if depth not in _PNG_DEPTHS.get(color_type, frozenset()):
                raise _invalid("unknown colour type or bit depth")
            if compression != 0 or filtering != 0 or interlace not in (0, 1):
                raise _invalid("unknown compression, filter or interlace method")
            if width == 0 or height == 0 or width > 0x7FFFFFFF or height > 0x7FFFFFFF:
                raise ImageRejected(
                    "case_files_dimensions", "The image has no width or height.", status=422,
                )
            seen_ihdr = True
            out.append(chunk)
            prev_idat = False
            continue
        if ctype == b"IDAT":
            if seen_idat and not prev_idat:
                raise _invalid("image data chunks are not consecutive")
            seen_idat = prev_idat = True
            out.append(chunk)
            continue
        prev_idat = False
        if ctype == b"PLTE":
            if seen_plte or seen_idat:
                raise _invalid("misplaced palette")
            if length == 0 or length % 3 or length > 768:
                raise _invalid("palette has the wrong length")
            seen_plte = True
            out.append(chunk)
            continue
        if ctype == b"IEND":
            if length != 0:
                raise _invalid("IEND carries data")
            seen_iend = True
            out.append(chunk)
            break
        if not ctype[0] & 0x20:
            # An upper-case first letter: a critical chunk this decoder set does not know.
            raise _invalid("unknown critical chunk")
        if ctype not in _PNG_KEEP:
            continue  # metadata (text, EXIF, time) and animation chunks are dropped
        if ctype == b"iCCP":
            if seen_iccp or length > MAX_ICC_BYTES:
                continue
            seen_iccp = True
        out.append(chunk)
    if not seen_iend:
        raise _invalid("no IEND chunk")
    if pos != n:
        raise _invalid("bytes after the end of the image")
    if not seen_idat:
        raise _invalid("no image data")
    if color_type == 3 and not seen_plte:
        raise _invalid("palette image without a palette")
    return b"".join(out), width, height


# --------------------------------------------------------------------------- #
# JPEG
# --------------------------------------------------------------------------- #
def _segment(marker: int, payload: bytes) -> bytes:
    return bytes((0xFF, marker)) + struct.pack(">H", len(payload) + 2) + payload


def _strip_jpeg(data: bytes) -> tuple[bytes, int, int]:
    n = len(data)
    if data[:2] != b"\xff\xd8":
        raise _unsupported()
    # (tag, bytes): ICC segments are tagged so all of them can be dropped together.
    parts: list[tuple[str, bytes]] = [("soi", b"\xff\xd8")]
    pos = 2
    size: tuple[int, int] | None = None
    seen_sos = seen_eoi = False
    icc_bytes = 0
    while pos < n:
        if data[pos] != 0xFF:
            raise _invalid("a marker was expected")
        while pos < n and data[pos] == 0xFF:
            pos += 1  # fill bytes before a marker
        if pos >= n:
            raise _invalid("truncated marker")
        marker = data[pos]
        pos += 1
        if marker == 0xD9:  # EOI
            parts.append(("eoi", b"\xff\xd9"))
            seen_eoi = True
            break
        if marker == 0x00 or marker == 0xD8 or 0xD0 <= marker <= 0xD7:
            raise _invalid("misplaced marker")
        if marker == 0x01:  # TEM: no payload; dropped
            continue
        if pos + 2 > n:
            raise _invalid("truncated segment")
        (length,) = struct.unpack(">H", data[pos:pos + 2])
        if length < 2 or pos + length > n:
            raise _invalid("segment length out of range")
        payload = data[pos + 2:pos + length]
        pos += length
        if marker in _JPEG_SOF:
            if size is not None:
                raise _invalid("more than one frame")
            if len(payload) < 6:
                raise _invalid("frame header is too short")
            precision = payload[0]
            (h,) = struct.unpack(">H", payload[1:3])
            (w,) = struct.unpack(">H", payload[3:5])
            components = payload[5]
            if precision not in (8, 12) or components not in (1, 3, 4):
                raise _invalid("unsupported frame")
            if len(payload) != 6 + 3 * components:
                raise _invalid("frame header has the wrong length")
            size = (w, h)
            parts.append(("sof", _segment(marker, payload)))
            continue
        if marker in _JPEG_TABLES:
            parts.append(("table", _segment(marker, payload)))
            continue
        if marker == 0xDA:  # SOS, then the entropy-coded data up to the next marker
            if size is None:
                raise _invalid("scan before the frame header")
            parts.append(("sos", _segment(marker, payload)))
            start = pos
            while True:
                idx = data.find(b"\xff", pos)
                if idx < 0 or idx + 1 >= n:
                    raise _invalid("no end of image")
                following = data[idx + 1]
                if following == 0x00 or 0xD0 <= following <= 0xD7:
                    pos = idx + 2  # a stuffed byte or a restart marker inside the scan
                    continue
                if following == 0xFF:
                    pos = idx + 1  # a fill byte before the next marker
                    continue
                end = idx
                while end > start and data[end - 1] == 0xFF:
                    end -= 1  # drop fill bytes; the marker loop skips them too
                parts.append(("scan", data[start:end]))
                pos = idx
                break
            seen_sos = True
            continue
        if 0xE0 <= marker <= 0xEF:
            if marker == 0xE0 and payload.startswith(b"JFIF\x00") and len(payload) >= 14:
                # Version, density units and densities; never the embedded thumbnail.
                parts.append(("app", _segment(0xE0, payload[:12] + b"\x00\x00")))
            elif marker == 0xE2 and payload.startswith(b"ICC_PROFILE\x00"):
                icc_bytes += len(payload)
                parts.append(("icc", _segment(marker, payload)))
            elif marker == 0xEE and payload.startswith(b"Adobe"):
                parts.append(("app", _segment(marker, payload)))
            continue  # Exif, XMP, IPTC and every other application segment are dropped
        if marker == 0xFE:  # COM
            continue
        raise _invalid("unsupported marker")
    if not seen_eoi:
        raise _invalid("no end of image")
    if pos != n:
        raise _invalid("bytes after the end of the image")
    if size is None or not seen_sos:
        raise _invalid("no image data")
    keep_icc = icc_bytes <= MAX_ICC_BYTES
    stripped = b"".join(chunk for tag, chunk in parts if tag != "icc" or keep_icc)
    return stripped, size[0], size[1]


# --------------------------------------------------------------------------- #
# WebP
# --------------------------------------------------------------------------- #
def _u24le(raw: bytes) -> int:
    return raw[0] | (raw[1] << 8) | (raw[2] << 16)


def _riff_chunk(fourcc: bytes, payload: bytes) -> bytes:
    pad = b"\x00" if len(payload) & 1 else b""
    return fourcc + struct.pack("<I", len(payload)) + payload + pad


def _vp8_size(payload: bytes) -> tuple[int, int]:
    if len(payload) < 10:
        raise _invalid("lossy image header is too short")
    tag = payload[0] | (payload[1] << 8) | (payload[2] << 16)
    if tag & 1:
        raise _invalid("lossy image is not a key frame")
    if (tag >> 1) & 0x7 > 3:
        raise _invalid("unknown lossy image version")
    if payload[3:6] != b"\x9d\x01\x2a":
        raise _invalid("lossy image start code missing")
    (w,) = struct.unpack("<H", payload[6:8])
    (h,) = struct.unpack("<H", payload[8:10])
    return w & 0x3FFF, h & 0x3FFF


def _vp8l_size(payload: bytes) -> tuple[int, int]:
    if len(payload) < 5 or payload[0] != 0x2F:
        raise _invalid("lossless image signature missing")
    (bits,) = struct.unpack("<I", payload[1:5])
    if bits >> 29:
        raise _invalid("unknown lossless image version")
    return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1


def _strip_webp(data: bytes) -> tuple[bytes, int, int]:
    n = len(data)
    (riff_size,) = struct.unpack("<I", data[4:8])
    if riff_size + 8 != n:
        raise _invalid("the file size does not match its header")
    chunks: list[tuple[bytes, bytes]] = []
    pos = 12
    while pos < n:
        if n - pos < 8:
            raise _invalid("truncated chunk")
        fourcc = data[pos:pos + 4]
        (size,) = struct.unpack("<I", data[pos + 4:pos + 8])
        end = pos + 8 + size
        padded = end + (size & 1)
        if padded > n:
            raise _invalid("truncated chunk")
        chunks.append((fourcc, data[pos + 8:end]))
        pos = padded
    if not chunks:
        raise _invalid("no image data")
    first, first_payload = chunks[0]
    if first in (b"VP8 ", b"VP8L"):
        # A simple file: its one image chunk; anything after it is dropped.
        width, height = (_vp8_size if first == b"VP8 " else _vp8l_size)(first_payload)
        body = _riff_chunk(first, first_payload)
        return b"RIFF" + struct.pack("<I", len(body) + 4) + b"WEBP" + body, width, height
    if first != b"VP8X":
        raise _invalid("unknown first chunk")
    if len(first_payload) != 10:
        raise _invalid("extended header has the wrong length")
    flags = first_payload[0]
    if flags & _WEBP_FLAG_ANIMATION:
        raise ImageRejected(
            "case_files_invalid_image", "Animated images are not accepted.", status=422,
        )
    width = _u24le(first_payload[4:7]) + 1
    height = _u24le(first_payload[7:10]) + 1
    kept: list[tuple[bytes, bytes]] = []
    image: bytes | None = None
    alpha = icc = False
    for fourcc, payload in chunks[1:]:
        if fourcc in (b"ANIM", b"ANMF"):
            raise ImageRejected(
                "case_files_invalid_image", "Animated images are not accepted.", status=422,
            )
        if fourcc in (b"VP8 ", b"VP8L"):
            if image is not None:
                raise _invalid("more than one image chunk")
            frame_w, frame_h = (_vp8_size if fourcc == b"VP8 " else _vp8l_size)(payload)
            _check_dimensions(frame_w, frame_h)
            image = fourcc
            kept.append((fourcc, payload))
            continue
        if fourcc == b"ALPH":
            if image is not None or alpha:
                raise _invalid("misplaced alpha chunk")
            alpha = True
            kept.append((fourcc, payload))
            continue
        if fourcc == b"ICCP":
            if image is not None or alpha or icc:
                raise _invalid("misplaced colour profile")
            if len(payload) <= MAX_ICC_BYTES:
                icc = True
                kept.append((fourcc, payload))
            continue
        # EXIF, XMP and unknown chunks are dropped.
    if image is None:
        raise _invalid("no image data")
    if alpha and image == b"VP8L":
        raise _invalid("alpha chunk with a lossless image")
    new_flags = flags & ~(_WEBP_FLAG_EXIF | _WEBP_FLAG_XMP)
    if not icc:
        new_flags &= ~_WEBP_FLAG_ICC
    header = bytes((new_flags,)) + first_payload[1:]
    body = _riff_chunk(b"VP8X", header) + b"".join(_riff_chunk(f, p) for f, p in kept)
    return b"RIFF" + struct.pack("<I", len(body) + 4) + b"WEBP" + body, width, height
