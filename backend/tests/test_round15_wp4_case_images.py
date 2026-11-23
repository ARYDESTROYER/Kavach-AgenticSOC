"""Round 15 WP4 (SPEC D5.3, D5.4): the stdlib screenshot validator and its corpus.

Every accepted format is checked against real files (``case_image_fixtures``, made
once with Pillow) and against files built here byte by byte, so each structural rule
has a test of its own: what is kept, what is stripped, what is refused and with which
code. The server never decodes pixels; that limitation is documented, not tested.
"""

from __future__ import annotations

import hashlib
import struct
import zlib

import pytest

from app.engine import case_images as ci
from app.engine.case_images import ImageRejected, validate_image
from tests import case_image_fixtures as fx


# --------------------------------------------------------------------------- #
# Builders.
# --------------------------------------------------------------------------- #
def chunk(ctype: bytes, body: bytes = b"", *, crc: int | None = None) -> bytes:
    value = zlib.crc32(ctype + body) & 0xFFFFFFFF if crc is None else crc
    return struct.pack(">I", len(body)) + ctype + body + struct.pack(">I", value)


def ihdr(width: int = 4, height: int = 3, depth: int = 8, color: int = 2, interlace: int = 0) -> bytes:
    return chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, depth, color, 0, 0, interlace))


def idat(width: int = 4, height: int = 3, channels: int = 3) -> bytes:
    raw = b"".join(b"\x00" + bytes(range(width * channels)) for _ in range(height))
    return chunk(b"IDAT", zlib.compress(raw))


def png(*middle: bytes, header: bytes | None = None, tail: bytes = b"") -> bytes:
    return ci._PNG_SIGNATURE + (header if header is not None else ihdr()) + b"".join(middle) + chunk(b"IEND") + tail


PLAIN_PNG = png(idat())


def segment(marker: int, payload: bytes) -> bytes:
    return bytes((0xFF, marker)) + struct.pack(">H", len(payload) + 2) + payload


def sof(width: int = 4, height: int = 3, marker: int = 0xC0) -> bytes:
    return segment(marker, bytes((8,)) + struct.pack(">HH", height, width) + b"\x03" + b"\x01\x22\x00\x02\x11\x01\x03\x11\x01")


def jpeg(*middle: bytes, frame: bytes | None = None, scan: bytes = b"\x12\x34\xff\x00\x56", tail: bytes = b"") -> bytes:
    sos = segment(0xDA, b"\x03\x01\x00\x02\x11\x03\x11\x00\x3f\x00")
    dqt = segment(0xDB, b"\x00" + bytes(64))
    dht = segment(0xC4, b"\x00" + bytes(16))
    return (b"\xff\xd8" + b"".join(middle) + dqt + (frame if frame is not None else sof()) + dht
            + sos + scan + b"\xff\xd9" + tail)


def riff(*chunks: bytes, size_delta: int = 0) -> bytes:
    body = b"WEBP" + b"".join(chunks)
    return b"RIFF" + struct.pack("<I", len(body) + size_delta) + body


def webp_chunk(fourcc: bytes, payload: bytes) -> bytes:
    return fourcc + struct.pack("<I", len(payload)) + payload + (b"\x00" if len(payload) & 1 else b"")


def vp8l(width: int = 4, height: int = 3) -> bytes:
    bits = (width - 1) | ((height - 1) << 14)
    return webp_chunk(b"VP8L", b"\x2f" + struct.pack("<I", bits) + b"\x00\x00\x00")


def vp8x(flags: int, width: int = 4, height: int = 3) -> bytes:
    w, h = width - 1, height - 1
    payload = bytes((flags, 0, 0, 0)) + bytes((w & 0xFF, (w >> 8) & 0xFF, (w >> 16) & 0xFF)) \
        + bytes((h & 0xFF, (h >> 8) & 0xFF, (h >> 16) & 0xFF))
    return webp_chunk(b"VP8X", payload)


def rejected(data: bytes, **kwargs) -> ImageRejected:
    with pytest.raises(ImageRejected) as caught:
        validate_image(data, **kwargs)
    return caught.value


REAL_FILES = {
    "PNG_METADATA": fx.PNG_METADATA,
    "APNG": fx.APNG,
    "JPEG_EXIF": fx.JPEG_EXIF,
    "JPEG_PROGRESSIVE_ICC": fx.JPEG_PROGRESSIVE_ICC,
    "JPEG_CMYK": fx.JPEG_CMYK,
    "JPEG_RESTART": fx.JPEG_RESTART,
    "JPEG_GRAY": fx.JPEG_GRAY,
    "WEBP_LOSSY": fx.WEBP_LOSSY,
    "WEBP_LOSSLESS": fx.WEBP_LOSSLESS,
    "WEBP_METADATA": fx.WEBP_METADATA,
    "WEBP_ALPHA": fx.WEBP_ALPHA,
}


# --------------------------------------------------------------------------- #
# Real files: accepted, stripped, stable.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("name", sorted(REAL_FILES))
def test_real_files_are_accepted_with_their_header_dimensions(name: str) -> None:
    image = validate_image(REAL_FILES[name])
    assert (image.width, image.height) == (9, 7)
    assert image.kind == name.split("_")[0].lower().replace("apng", "png")
    assert image.sha256 == hashlib.sha256(image.data).hexdigest()
    assert image.size == len(image.data)
    assert image.mime == ci.MIME_TYPES[image.kind]


@pytest.mark.parametrize("name", sorted(REAL_FILES))
def test_stripping_is_idempotent(name: str) -> None:
    once = validate_image(REAL_FILES[name])
    assert validate_image(once.data).data == once.data


@pytest.mark.parametrize("name", ["PNG_METADATA", "JPEG_EXIF", "WEBP_METADATA"])
def test_metadata_never_survives(name: str) -> None:
    raw = REAL_FILES[name]
    assert b"SECRET" in raw
    out = validate_image(raw).data
    assert b"SECRET" not in out
    assert b"Exif\x00" not in out and b"eXIf" not in out and b"EXIF" not in out
    assert len(out) < len(raw)


def test_png_text_exif_and_time_chunks_are_dropped_and_the_profile_kept() -> None:
    profile = chunk(b"iCCP", b"sRGB\x00\x00" + zlib.compress(b"profile"))
    data = png(chunk(b"tEXt", b"Author\x00SECRET"), chunk(b"zTXt", b"k\x00\x00" + zlib.compress(b"SECRET")),
               chunk(b"iTXt", b"k\x00\x00\x00\x00\x00SECRET"), chunk(b"eXIf", b"MM\x00*SECRET"),
               chunk(b"tIME", b"\x07\xea\x01\x01\x00\x00\x00"), profile, chunk(b"pHYs", bytes(9)), idat())
    out = validate_image(data).data
    assert b"SECRET" not in out and b"tIME" not in out
    assert profile in out and b"pHYs" in out


def test_png_oversized_profile_is_dropped() -> None:
    big = chunk(b"iCCP", b"p\x00\x00" + bytes(ci.MAX_ICC_BYTES))
    out = validate_image(png(big, idat())).data
    assert b"iCCP" not in out


def test_apng_becomes_its_still_image() -> None:
    assert b"acTL" in fx.APNG and b"fdAT" in fx.APNG
    out = validate_image(fx.APNG).data
    assert b"acTL" not in out and b"fcTL" not in out and b"fdAT" not in out


def test_polyglot_text_chunk_payload_is_removed() -> None:
    zip_bytes = b"PK\x03\x04" + b"payload" * 10
    out = validate_image(png(chunk(b"tEXt", b"z\x00" + zip_bytes), idat())).data
    assert b"PK\x03\x04" not in out


def test_jpeg_keeps_profile_adobe_and_restart_markers() -> None:
    assert b"ICC_PROFILE\x00" in validate_image(fx.JPEG_PROGRESSIVE_ICC).data
    assert b"Adobe" in validate_image(fx.JPEG_CMYK).data
    out = validate_image(fx.JPEG_RESTART).data
    assert any(bytes((0xFF, m)) in out for m in range(0xD0, 0xD8))


def test_jpeg_jfif_thumbnail_is_removed() -> None:
    jfif = b"JFIF\x00\x01\x02\x00\x00\x48\x00\x48" + b"\x02\x02" + b"SECRET" * 2
    out = validate_image(jpeg(segment(0xE0, jfif))).data
    assert b"SECRET" not in out
    assert segment(0xE0, jfif[:12] + b"\x00\x00") in out


def test_jpeg_drops_every_icc_segment_when_the_profile_is_too_large() -> None:
    half = b"ICC_PROFILE\x00" + bytes(ci.MAX_ICC_BYTES // 2 + 100)
    out = validate_image(jpeg(segment(0xE2, half), segment(0xE2, half))).data
    assert b"ICC_PROFILE" not in out


def test_jpeg_drops_xmp_iptc_and_comments() -> None:
    data = jpeg(segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00SECRET"), segment(0xED, b"Photoshop 3.0\x00SECRET"),
                segment(0xFE, b"SECRET"))
    assert b"SECRET" not in validate_image(data).data


def test_jpeg_fill_bytes_before_end_of_image_are_tolerated() -> None:
    data = jpeg(scan=b"\x12\x34\xff\xff\xff")
    assert validate_image(data).kind == "jpeg"


def test_webp_extended_flags_are_cleared_with_the_metadata() -> None:
    flags = ci._WEBP_FLAG_EXIF | ci._WEBP_FLAG_XMP | ci._WEBP_FLAG_ICC
    data = riff(vp8x(flags), vp8l(), webp_chunk(b"EXIF", b"SECRET"), webp_chunk(b"XMP ", b"SECRET!"))
    out = validate_image(data).data
    assert b"SECRET" not in out
    flag_byte = out[20]
    assert not flag_byte & (ci._WEBP_FLAG_EXIF | ci._WEBP_FLAG_XMP | ci._WEBP_FLAG_ICC)
    (riff_size,) = struct.unpack("<I", out[4:8])
    assert riff_size + 8 == len(out)


def test_webp_simple_file_drops_trailing_chunks() -> None:
    out = validate_image(riff(vp8l(), webp_chunk(b"EXIF", b"SECRET"))).data
    assert b"SECRET" not in out


# --------------------------------------------------------------------------- #
# Refusals.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("name, data", [
    ("gif", fx.GIF), ("bmp", fx.BMP), ("tiff", fx.TIFF), ("ico", fx.ICO),
    ("svg", b"<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>"),
    ("xml", b"<?xml version='1.0'?><svg/>"),
    ("pdf", b"%PDF-1.7\n1 0 obj\n"),
    ("heic", b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic"),
    ("html", b"<!doctype html><script>alert(1)</script>"),
])
def test_other_types_are_unsupported(name: str, data: bytes) -> None:
    err = rejected(data)
    assert (err.code, err.status) == ("case_files_unsupported_type", 415)


def test_empty_upload_is_invalid() -> None:
    assert rejected(b"").code == "case_files_invalid_image"


def test_declared_type_must_match_the_magic_bytes() -> None:
    assert validate_image(PLAIN_PNG, declared="image/png").kind == "png"
    assert validate_image(fx.JPEG_GRAY, declared="image/jpg").kind == "jpeg"
    for declared in ("image/jpeg", "image/svg+xml", "text/html", ""):
        err = rejected(PLAIN_PNG, declared=declared)
        assert (err.code, err.status) == ("case_files_unsupported_type", 415)


@pytest.mark.parametrize("label, data", [
    ("bad crc", ci._PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 3, 8, 2, 0, 0, 0), crc=1) + idat() + chunk(b"IEND")),
    ("truncated", PLAIN_PNG[:-6]),
    ("no IEND", ci._PNG_SIGNATURE + ihdr() + idat()),
    ("trailing bytes", png(idat(), tail=b"PK\x03\x04zip")),
    ("first chunk not IHDR", ci._PNG_SIGNATURE + idat() + ihdr() + chunk(b"IEND")),
    ("two IHDR", png(ihdr(), idat())),
    ("unknown critical", png(chunk(b"ABCD", b"x"), idat())),
    ("idat split", png(idat(), chunk(b"tEXt", b"a\x00b"), idat())),
    ("palette without PLTE", png(idat(), header=ihdr(color=3))),
    ("bad depth", png(idat(), header=ihdr(depth=3))),
    ("bad colour type", png(idat(), header=ihdr(color=5))),
    ("bad interlace", png(idat(), header=ihdr(interlace=2))),
    ("no image data", png()),
    ("IEND with data", ci._PNG_SIGNATURE + ihdr() + idat() + chunk(b"IEND", b"x")),
    ("non-letter type", png(chunk(b"tE1t", b"x"), idat())),
    ("palette after data", png(idat(), chunk(b"PLTE", bytes(3)))),
])
def test_png_structure_errors_are_refused(label: str, data: bytes) -> None:
    err = rejected(data)
    assert err.status == 422, label
    assert err.code in {"case_files_invalid_image", "case_files_dimensions"}, label


@pytest.mark.parametrize("width, height", [(0, 3), (ci.MAX_SIDE_PX + 1, 10), (10, ci.MAX_SIDE_PX + 1), (8000, 6000)])
def test_png_dimension_caps(width: int, height: int) -> None:
    err = rejected(png(idat(), header=ihdr(width=width, height=height)))
    assert (err.code, err.status) == ("case_files_dimensions", 422)


def test_png_at_the_dimension_caps_is_accepted() -> None:
    assert validate_image(png(idat(), header=ihdr(width=ci.MAX_SIDE_PX, height=4882))).width == ci.MAX_SIDE_PX


@pytest.mark.parametrize("label, data", [
    ("trailing bytes", jpeg(tail=b"<script>")),
    ("no EOI", jpeg()[:-2]),
    ("second SOI", jpeg(b"\xff\xd8")),
    ("scan before frame", b"\xff\xd8" + segment(0xDA, b"\x01\x01\x00\x00\x3f\x00") + b"\x00\xff\xd9"),
    ("two frames", jpeg(sof())),
    ("hierarchical", jpeg(segment(0xDE, b"\x00\x00"))),
    ("jpeg-ls", jpeg(frame=segment(0xF7, b"\x08\x00\x03\x00\x04\x01\x01\x11\x00"))),
    ("stray restart", jpeg(b"\xff\xd0")),
    ("reserved marker", jpeg(segment(0x02, b"\x00"))),
    ("bad length", b"\xff\xd8\xff\xdb\x00\x01" + jpeg()[2:]),
    ("garbage between segments", jpeg(segment(0xE0, b"JFIF\x00" + bytes(9)), b"\x00\x00")),
    ("12-bit components", jpeg(frame=segment(0xC0, b"\x08\x00\x03\x00\x04\x02\x01\x11\x00"))),
])
def test_jpeg_structure_errors_are_refused(label: str, data: bytes) -> None:
    err = rejected(data)
    assert (err.code, err.status) == ("case_files_invalid_image", 422), label


def test_jpeg_dimension_caps() -> None:
    err = rejected(jpeg(frame=sof(width=ci.MAX_SIDE_PX + 1, height=10)))
    assert err.code == "case_files_dimensions"
    assert rejected(jpeg(frame=sof(width=10, height=0))).code == "case_files_dimensions"


@pytest.mark.parametrize("label, data", [
    ("size mismatch", riff(vp8l(), size_delta=4)),
    ("trailing bytes", riff(vp8l()) + b"PK"),
    ("unknown first chunk", riff(webp_chunk(b"ABCD", b"xx"))),
    ("empty", riff()),
    ("truncated chunk", riff(b"VP8L" + struct.pack("<I", 99) + b"\x2f")),
    ("lossless signature", riff(webp_chunk(b"VP8L", b"\x00\x00\x00\x00\x00"))),
    ("lossy start code", riff(webp_chunk(b"VP8 ", bytes(10)))),
    ("two images", riff(vp8x(0), vp8l(), vp8l())),
    ("alpha with lossless", riff(vp8x(0x10), webp_chunk(b"ALPH", b"\x00\x00"), vp8l())),
    ("extended header length", riff(webp_chunk(b"VP8X", bytes(4)), vp8l())),
])
def test_webp_structure_errors_are_refused(label: str, data: bytes) -> None:
    err = rejected(data)
    assert (err.code, err.status) == ("case_files_invalid_image", 422), label


def test_animated_webp_is_refused() -> None:
    err = rejected(fx.WEBP_ANIMATED)
    assert err.code == "case_files_invalid_image" and "Animated" in err.message
    assert rejected(riff(vp8x(0), webp_chunk(b"ANIM", bytes(6)), vp8l())).code == "case_files_invalid_image"


def test_webp_canvas_dimension_caps() -> None:
    err = rejected(riff(vp8x(0, width=ci.MAX_SIDE_PX + 1, height=4), vp8l()))
    assert err.code == "case_files_dimensions"


def test_stored_size_cap_applies_after_stripping() -> None:
    padded = png(chunk(b"tEXt", b"k\x00" + bytes(5000)), idat())
    small_cap = len(PLAIN_PNG) + 10
    assert validate_image(padded, max_bytes=small_cap).size <= small_cap
    err = rejected(PLAIN_PNG, max_bytes=len(PLAIN_PNG) - 1)
    assert (err.code, err.status) == ("case_files_too_large", 413)


def test_refusal_messages_never_quote_the_upload() -> None:
    marker = b"SECRET-NAME"
    for data in (marker, png(idat(), tail=marker), jpeg(tail=marker), riff(vp8l()) + marker):
        err = rejected(data)
        assert "SECRET" not in err.message and "SECRET" not in str(err)


def test_module_is_stdlib_only_and_never_imports_the_decision_core() -> None:
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(ci))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, "case_images imports nothing from the app"
            imported.add((node.module or "").split(".")[0])
    assert imported <= {"__future__", "hashlib", "struct", "zlib", "dataclasses", "typing"}
