#!/usr/bin/env python3
"""Standard-library tests for ``scripts/build_release_notes.py`` (Round 16 WP07).

Every schema rule has a rejecting case; a valid fixture renders the three outputs
deterministically; ``--check`` names each stale output; and the committed notes of this
tree pass and are current.
"""

from __future__ import annotations

import copy
import json
import struct
import tempfile
import unittest
from pathlib import Path

import build_release_notes as notes


def _riff(chunk: bytes, payload: bytes) -> bytes:
    body = b"WEBP" + chunk + struct.pack("<I", len(payload)) + payload
    return b"RIFF" + struct.pack("<I", len(body)) + body


def webp_vp8x(width: int, height: int, pad: int = 0) -> bytes:
    payload = b"\x00\x00\x00\x00" + (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little")
    return _riff(b"VP8X", payload + b"\x00" * pad)


def webp_vp8(width: int, height: int) -> bytes:
    payload = b"\x10\x02\x00" + b"\x9d\x01\x2a" + struct.pack("<HH", width, height) + b"\x00" * 8
    return _riff(b"VP8 ", payload)


def webp_vp8l(width: int, height: int) -> bytes:
    bits = (width - 1) | ((height - 1) << 14)
    return _riff(b"VP8L", b"\x2f" + struct.pack("<I", bits) + b"\x00" * 8)


PUBLIC_PAGES = frozenset({
    "index.md", "analyst/case-manager.md", "getting-started/index.md", "releases/0.2.0.md",
    "releases/0.1.13.md", "releases/0.1.12.md", "releases/whats-new.md", "releases/0.1.md",
})


def make_ctx(root: Path, version: str = "0.2.0") -> notes.Context:
    return notes.Context(
        root=root,
        current_version=version,
        console_pages=frozenset({"case_manager", "overview", "whats_new"}),
        permissions=frozenset({"cases:read", "users:manage"}),
        public_pages=PUBLIC_PAGES,
        excluded_assets=frozenset({"assets/screenshots/hidden.webp"}),
    )


def valid_release() -> dict:
    return {
        "schema": 1,
        "version": "0.2.0",
        "status": "testing",
        "date": None,
        "title": "Visible AI work",
        "summary": "Everything since 0.1.1 in one release.",
        "docs": "releases/0.2.0/",
        "updates": [
            {
                "id": "0.2.0.2026-12",
                "date": None,
                "title": "What's new",
                "highlights": [
                    {
                        "id": "case-tabs",
                        "kind": "improved",
                        "area": "cases",
                        "title": "Case tabs in a new order",
                        "summary": "Alt+2 now opens **Evidence** and `Alt+6` opens Chat.",
                        "details": ["Chat moves to Alt+6."],
                        "featured": True,
                        "requires": "cases:read",
                        "open": {"page": "case_manager"},
                        "help": "analyst/case-manager/#tabs",
                        "screenshot": {
                            "light": "tabs-light.webp",
                            "dark": "tabs-dark.webp",
                            "alt": "The case detail with the six tabs Brief, Evidence and Chat in order.",
                            "caption": "The six case tabs",
                        },
                    }
                ],
            },
            {
                "id": "0.2.0.2026-11-25",
                "date": "2026-11-25",
                "title": "Team activity",
                "highlights": [
                    {
                        "id": "team",
                        "kind": "new",
                        "area": "administration",
                        "title": "Team activity",
                        "summary": "Per-person work counts.",
                        "help": "getting-started/",
                        "screenshot": {
                            "light": "screenshots/shared.webp",
                            "alt": "The Team activity page with one bar per day for the selected range.",
                        },
                    }
                ],
            },
        ],
        "records": [
            {"version": "0.1.12", "date": "2026-08-05", "summary": "Bootstrap blocked", "docs": "releases/0.1.12/"},
            {"version": "0.1.13", "date": "2026-08-05", "summary": "Unpublished candidate", "docs": "releases/0.1.13/"},
        ],
    }


class ReleaseNotesTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.root = Path(self._temp.name)
        release_assets = self.root / "docs/assets/releases/0.2.0"
        release_assets.mkdir(parents=True)
        (release_assets / "tabs-light.webp").write_bytes(webp_vp8x(2880, 1800))
        (release_assets / "tabs-dark.webp").write_bytes(webp_vp8(1440, 900))
        shared = self.root / "docs/assets/screenshots"
        shared.mkdir(parents=True)
        (shared / "shared.webp").write_bytes(webp_vp8l(1280, 800))
        (shared / "hidden.webp").write_bytes(webp_vp8x(100, 100))
        self.ctx = make_ctx(self.root)

    def tearDown(self) -> None:
        self._temp.cleanup()

    def validate(self, data: dict, file_name: str = "0.2.0.json") -> dict:
        return notes.validate_release(data, file_name, self.ctx)

    def assertRejects(self, data: dict, fragment: str, file_name: str = "0.2.0.json") -> None:
        with self.assertRaises(notes.NotesError) as caught:
            self.validate(data, file_name)
        self.assertIn(fragment, str(caught.exception))

    def write_notes(self, *releases: dict) -> Path:
        directory = self.root / "docs/releases/notes"
        directory.mkdir(parents=True, exist_ok=True)
        for release in releases:
            (directory / f"{release['version']}.json").write_text(json.dumps(release), encoding="utf-8")
        return directory


class ValidReleaseTests(ReleaseNotesTestCase):
    def test_a_valid_release_normalises_with_image_sizes_from_each_header_form(self) -> None:
        out = self.validate(valid_release())
        shot = out["updates"][0]["highlights"][0]["screenshot"]
        self.assertEqual(shot["light"], {"src": "assets/releases/0.2.0/tabs-light.webp", "width": 2880, "height": 1800})
        self.assertEqual(shot["dark"], {"src": "assets/releases/0.2.0/tabs-dark.webp", "width": 1440, "height": 900})
        shared = out["updates"][1]["highlights"][0]["screenshot"]
        self.assertEqual(shared["light"], {"src": "assets/screenshots/shared.webp", "width": 1280, "height": 800})
        self.assertIsNone(shared["dark"])
        # Records are sorted newest first whatever their file order.
        self.assertEqual([r["version"] for r in out["records"]], ["0.1.13", "0.1.12"])
        highlight = out["updates"][1]["highlights"][0]
        self.assertEqual(
            (highlight["details"], highlight["featured"], highlight["requires"], highlight["open"]),
            ([], False, None, None),
        )

    def test_outputs_are_deterministic_and_name_the_newest_update(self) -> None:
        directory = self.write_notes(valid_release())
        loaded = notes.load_notes(self.ctx, directory)
        first = notes.outputs(loaded)
        second = notes.outputs(notes.load_notes(self.ctx, directory))
        self.assertEqual(first, second)
        self.assertEqual(loaded.latest, "0.2.0.2026-12")
        backend = json.loads(first[notes.BACKEND_OUTPUT])
        self.assertEqual(backend["latest_update_id"], "0.2.0.2026-12")
        self.assertEqual(backend["version"], "0.2.0")
        web = json.loads(first[notes.WEB_OUTPUT])
        self.assertEqual(web["latest"], "0.2.0.2026-12")
        self.assertEqual(web["releases"][0]["updates"][0]["highlights"][0]["id"], "case-tabs")
        for text in first.values():
            self.assertTrue(text.endswith("\n"))
            self.assertNotIn("\r", text)

    def test_the_newest_update_comes_from_the_highest_version(self) -> None:
        older = valid_release()
        older.update(version="0.1.1", status="released", date="2026-07-31", records=[])
        older["updates"] = [copy.deepcopy(older["updates"][1])]
        older["updates"][0].update(id="0.1.1.2026-07-31", date="2026-07-31")
        older["updates"][0]["highlights"][0]["screenshot"] = None
        del older["updates"][0]["highlights"][0]["screenshot"]
        directory = self.write_notes(valid_release(), older)
        loaded = notes.load_notes(self.ctx, directory)
        self.assertEqual([r["version"] for r in loaded.releases], ["0.2.0", "0.1.1"])
        self.assertEqual(loaded.latest, "0.2.0.2026-12")

    def test_the_help_center_page_links_relatively_and_draws_both_themes(self) -> None:
        directory = self.write_notes(valid_release())
        page = notes.doc_output(notes.load_notes(self.ctx, directory))
        self.assertTrue(page.startswith("---\ntitle: What's new\n"))
        self.assertEqual(page.count("\n# "), 1)
        self.assertIn("[Agentic SOC 0.2.0 release record](0.2.0.md)", page)
        self.assertIn("[Read more](../analyst/case-manager.md#tabs)", page)
        self.assertIn("[Read more](../getting-started/index.md)", page)
        self.assertIn("../assets/releases/0.2.0/tabs-light.webp#only-light", page)
        self.assertIn("../assets/releases/0.2.0/tabs-dark.webp#only-dark", page)
        # A light-only screenshot is shown in both themes (no #only-light).
        self.assertIn("(../assets/screenshots/shared.webp) ]", page)
        # An update heading is the date alone and its title opens the section: chat's
        # product help weighs headings three times, so a title naming features would
        # outrank the page that explains them.
        self.assertIn("### Not yet released\n\nWhat's new", page)
        self.assertIn("### 25 November 2026\n\nTeam activity", page)
        self.assertNotRegex(page, r"(?m)^### (Not yet released|\d{1,2} [A-Z][a-z]+ \d{4}):")
        self.assertIn("What changed in this version, newest first.", page)
        self.assertIn("### Earlier release records folded into 0.2.0", page)
        self.assertIn("- [Agentic SOC 0.1.13](0.1.13.md), 5 August 2026. Unpublished candidate.", page)
        self.assertNotIn("\n\n\n", page)
        self.assertNotIn("\u2014", page)


class RejectionTests(ReleaseNotesTestCase):
    def test_release_identity_rules(self) -> None:
        data = valid_release()
        data["version"] = "0.2"
        self.assertRejects(data, "release version")
        data = valid_release()
        data["version"] = "0.2.0-rc.1"
        self.assertRejects(data, "release version")
        self.assertRejects(valid_release(), "file name must be 0.2.0.json", file_name="0.2.1.json")
        data = valid_release()
        data["schema"] = 2
        self.assertRejects(data, "schema must be 1")
        data = valid_release()
        data["extra"] = True
        self.assertRejects(data, "unknown keys ['extra']")
        data = valid_release()
        del data["summary"]
        self.assertRejects(data, "missing keys ['summary']")

    def test_status_and_dates(self) -> None:
        data = valid_release()
        data["status"] = "preview"
        self.assertRejects(data, "status must be one of")
        data = valid_release()
        data["status"] = "released"
        self.assertRejects(data, "date: a date is required")
        data = valid_release()
        data.update(status="released", date="2026-12-01")
        self.assertRejects(data, "updates[0].date: a date is required")
        older = valid_release()
        older["version"] = "0.1.1"
        self.assertRejects(older, "only the current version", file_name="0.1.1.json")
        data = valid_release()
        data["updates"][1]["date"] = "2026-11-31"
        self.assertRejects(data, "not a calendar date")
        data = valid_release()
        data["updates"][1]["date"] = "25 Nov 2026"
        self.assertRejects(data, "ISO date")

    def test_updates_are_newest_first_with_unique_ids_in_the_grammar(self) -> None:
        data = valid_release()
        data["updates"][0].update(date="2026-11-01")
        self.assertRejects(data, "is newer than the update before it")
        data = valid_release()
        data["updates"].reverse()
        self.assertRejects(data, "undated after a dated update")
        data = valid_release()
        data["updates"][0]["id"] = "0.2.0 December"
        self.assertRejects(data, "id must match")
        data = valid_release()
        data["updates"][0]["id"] = "0.1.13.2026-12"
        self.assertRejects(data, "must start with '0.2.0.'")
        data = valid_release()
        data["updates"] = []
        self.assertRejects(data, "non-empty list")
        data = valid_release()
        data["updates"][1]["highlights"][0]["id"] = "case-tabs"
        self.assertRejects(data, "used twice in this release")

    def test_an_update_id_is_unique_across_files(self) -> None:
        older = valid_release()
        older.update(version="0.1.1", status="released", date="2026-12-31", records=[])
        older["updates"] = [copy.deepcopy(older["updates"][1])]
        del older["updates"][0]["highlights"][0]["screenshot"]
        older["updates"][0]["id"] = "0.1.1.dup"
        newer = valid_release()
        newer["updates"][1]["id"] = "0.2.0.dup"
        directory = self.write_notes(newer, older)
        notes.load_notes(self.ctx, directory)  # distinct ids load
        # The same id in two files is refused (bypass the per-file prefix rule).
        loaded_old = notes.validate_release(older, "0.1.1.json", self.ctx)
        loaded_new = notes.validate_release(newer, "0.2.0.json", self.ctx)
        loaded_old["updates"][0]["id"] = loaded_new["updates"][1]["id"]
        original = notes.validate_release
        try:
            notes.validate_release = lambda raw, name, ctx: loaded_new if name == "0.2.0.json" else loaded_old
            with self.assertRaises(notes.NotesError) as caught:
                notes.load_notes(self.ctx, directory)
        finally:
            notes.validate_release = original
        self.assertIn("used in more than one release", str(caught.exception))

    def test_the_newest_notes_must_be_for_the_current_version(self) -> None:
        directory = self.write_notes(valid_release())
        with self.assertRaises(notes.NotesError) as caught:
            notes.load_notes(make_ctx(self.root, version="0.2.1"), directory)
        self.assertIn("only the current version", str(caught.exception))
        released = valid_release()
        released.update(status="released", date="2026-12-01")
        released["updates"][0]["date"] = "2026-12-01"
        directory = self.write_notes(released)
        with self.assertRaises(notes.NotesError) as caught:
            notes.load_notes(make_ctx(self.root, version="0.2.1"), directory)
        self.assertIn("add 0.2.1.json", str(caught.exception))
        with self.assertRaises(notes.NotesError) as caught:
            notes.load_notes(self.ctx, self.root / "missing")
        self.assertIn("no release notes", str(caught.exception))

    def test_closed_kind_area_and_known_targets(self) -> None:
        cases = [
            (("kind",), "feature", "kind must be one of"),
            (("area",), "everything", "area must be one of"),
            (("requires",), "cases", "must be 'resource:action'"),
            (("requires",), "cases:delete", "is not a permission"),
            (("open",), {"page": "nowhere"}, "is not a Console page"),
            (("open",), {"page": "overview", "tab": "x"}, "unknown keys ['tab']"),
            (("help",), "analyst/missing/", "not a public Help Center page"),
            (("help",), "https://example.com/", "Help Center path"),
            (("featured",), "yes", "featured must be true or false"),
            (("details",), ["x"] * 13, "at most 12"),
        ]
        for keys, value, fragment in cases:
            with self.subTest(fragment=fragment):
                data = valid_release()
                data["updates"][0]["highlights"][0][keys[0]] = value
                self.assertRejects(data, fragment)

    def test_screenshots(self) -> None:
        def with_shot(**changes: object) -> dict:
            data = valid_release()
            data["updates"][0]["highlights"][0]["screenshot"].update(changes)
            return data

        self.assertRejects(with_shot(light="missing.webp"), "does not exist")
        self.assertRejects(with_shot(light="tabs.png"), ".webp file name")
        self.assertRejects(with_shot(light="../tabs-light.webp"), ".webp file name")
        self.assertRejects(with_shot(light="screenshots/hidden.webp"), "excluded from the Help Center bundle")
        self.assertRejects(with_shot(alt="Too short"), "at least 40 characters")
        self.assertRejects(
            with_shot(alt="Image of the case detail with six tabs in their new order on screen."),
            "not 'image of'",
        )
        data = valid_release()
        del data["updates"][0]["highlights"][0]["screenshot"]["alt"]
        self.assertRejects(data, "missing keys ['alt']")
        # Featured needs both themes.
        data = valid_release()
        del data["updates"][0]["highlights"][0]["screenshot"]["dark"]
        self.assertRejects(data, "needs a light and a dark screenshot")
        data = valid_release()
        del data["updates"][0]["highlights"][0]["screenshot"]
        self.assertRejects(data, "needs a light and a dark screenshot")

        assets = self.root / "docs/assets/releases/0.2.0"
        (assets / "fake.webp").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 40)
        self.assertRejects(with_shot(light="fake.webp"), "not a WebP file")
        (assets / "wide.webp").write_bytes(webp_vp8x(2881, 1800))
        self.assertRejects(with_shot(light="wide.webp"), "2881 px wide, at most 2880")
        (assets / "heavy.webp").write_bytes(webp_vp8x(1440, 900, pad=250 * 1024))
        self.assertRejects(with_shot(light="heavy.webp"), "bytes, at most 256,000")

    def test_plain_text_rules(self) -> None:
        bad = {
            "<b>bold</b>": "markup (<)",
            "Read https://example.com": "raw URL",
            "See www.example.com": "raw URL",
            "See [the docs](x)": "Markdown link",
            "# Heading": "Markdown link or block syntax",
            "Zero\u200bwidth": "hidden character U+200B",
            "Tab\tinside": "hidden character U+0009",
            "Line\nbreak": "hidden character U+000A",
            "Before \u2014 after": "an em dash",
            "Before \u2013 after": "an en dash",
            "No\u00a0break": "a no-break space",
            "C:\\path": "a backslash",
            "Round 16 work": "never says 'Round'",
            "The playbook page": "says 'playbook'",
            "An **unclosed marker": "unclosed",
            " padded": "no leading or trailing spaces",
            "": "non-empty",
            "x" * 201: "at most 200",
        }
        for text, fragment in bad.items():
            with self.subTest(text=text):
                data = valid_release()
                data["updates"][0]["highlights"][0]["summary"] = text
                self.assertRejects(data, fragment)
        for text in ("Open data:text/html,x", "See file:///etc/hosts", "Mail mailto:soc@example.test",
                     "Run javascript:alert(1)", "FTP ftp://host"):
            with self.subTest(text=text):
                data = valid_release()
                data["updates"][0]["highlights"][0]["summary"] = text
                self.assertRejects(data, "raw URL")
        # A word that only looks like a scheme, followed by a colon and a space, is prose.
        for text in ("Export your data: CSV or JSON Lines.", "Each file: one case.", "Mail: the digest."):
            with self.subTest(text=text):
                data = valid_release()
                data["updates"][0]["highlights"][0]["summary"] = text
                self.assertEqual(self.validate(data)["updates"][0]["highlights"][0]["summary"], text)
        data = valid_release()
        data["updates"][0]["title"] = "Round up"
        self.assertRejects(data, "never says 'Round'")
        data = valid_release()
        data["title"] = 7
        self.assertRejects(data, "must be a string")

    def test_records(self) -> None:
        data = valid_release()
        data["records"][0]["version"] = "0.2.0"
        self.assertRejects(data, "is not older than 0.2.0")
        data = valid_release()
        data["records"][1]["version"] = "0.1.12"
        self.assertRejects(data, "is listed twice")
        data = valid_release()
        data["records"][0]["docs"] = "releases/0.1.9/"
        self.assertRejects(data, "not a public Help Center page")


class CheckModeTests(ReleaseNotesTestCase):
    def test_check_names_each_stale_output(self) -> None:
        directory = self.write_notes(valid_release())
        rendered = notes.outputs(notes.load_notes(self.ctx, directory))
        for relative, text in rendered.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        self.assertEqual(notes.stale_outputs(self.root, rendered), [])
        for relative in rendered:
            with self.subTest(output=relative.as_posix()):
                path = self.root / relative
                original = path.read_text(encoding="utf-8")
                path.write_text(original.replace("0.2.0", "0.2.9", 1), encoding="utf-8")
                self.assertEqual(notes.stale_outputs(self.root, rendered), [relative.as_posix()])
                path.unlink()
                self.assertEqual(notes.stale_outputs(self.root, rendered), [relative.as_posix()])
                path.write_text(original, encoding="utf-8")
        # A CRLF checkout is not stale.
        first = self.root / notes.DOC_OUTPUT
        first.write_bytes(first.read_bytes().replace(b"\n", b"\r\n"))
        self.assertEqual(notes.stale_outputs(self.root, rendered), [])

    def test_the_committed_notes_are_valid_and_current(self) -> None:
        self.assertEqual(notes.main(["--check"]), 0)

    def test_the_committed_notes_name_the_current_version_and_real_pages(self) -> None:
        ctx = notes.Context.load(notes.ROOT)
        loaded = notes.load_notes(ctx)
        self.assertEqual(loaded.releases[0]["version"], ctx.current_version)
        self.assertIn("whats_new", ctx.console_pages)
        self.assertIn("cases:read", ctx.permissions)
        self.assertIn("releases/whats-new.md", ctx.public_pages)
        latest = json.loads((notes.ROOT / notes.BACKEND_OUTPUT).read_text(encoding="utf-8"))
        self.assertEqual(latest["latest_update_id"], loaded.latest)



class IntroTests(unittest.TestCase):
    def test_the_intro_names_where_the_switch_really_is(self) -> None:
        """The page says where **Show What's new after updates** is, as the Console
        builds it: the Appearance section of the Account group of Settings."""
        webui = notes.ROOT / "webui" / "src" / "soc"
        meta = (webui / "pages" / "settings" / "settings-sections-meta.ts").read_text(encoding="utf-8")
        section = meta[meta.index("id: 'customization',"):]
        section = section[: section.index("},")]
        group = section.split("group: '", 1)[1].split("'", 1)[0]
        title = section.split("title: '", 1)[1].split("'", 1)[0]
        label = meta.split(f"{{ id: '{group}', label: '", 1)[1].split("'", 1)[0]
        host = (webui / "components" / "CustomizationSection.tsx").read_text(encoding="utf-8")
        self.assertIn("Show What&apos;s new after updates", host)
        self.assertEqual((label, title), ("Account", "Appearance"))
        page = notes.doc_output(notes.load_notes(notes.Context.load(notes.ROOT)))
        intro = page[page.index("# What's new"): page.index("## Agentic SOC")]
        self.assertIn(
            f"**Show What's new after updates** in **Settings → {label} → {title}**",
            " ".join(intro.split()),
        )
        self.assertNotIn("Settings, Appearance", intro)

if __name__ == "__main__":
    unittest.main()
