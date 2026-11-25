#!/usr/bin/env python3
"""Focused standard-library tests for the installed documentation artifact."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import build_docs_bundle as bundle
import run_docs_bundle as runner


class DocumentationBundleTests(unittest.TestCase):
    def test_wrapper_resolves_npm_output_from_webui_working_directory(self) -> None:
        webui = bundle.ROOT / "webui"
        arguments = runner.normalize_arguments(
            ["--output", "public/docs", "--check-only"],
            webui,
        )
        self.assertEqual(
            arguments,
            ["--output", str(webui / "public" / "docs"), "--check-only"],
        )

    def test_documentation_version_uses_major_minor(self) -> None:
        self.assertEqual(bundle.documentation_version("0.1.1"), "0.1")
        self.assertEqual(bundle.documentation_version("12.34.56-rc.2+build.7"), "12.34")

    def test_unknown_channel_fails_safe_to_testing(self) -> None:
        self.assertEqual(bundle.release_channel({}), "Testing")
        self.assertEqual(
            bundle.release_channel({"TLSOC_RELEASE_CHANNEL": "preview"}),
            "Testing",
        )
        self.assertEqual(
            bundle.release_channel({"TLSOC_RELEASE_CHANNEL": "stable"}),
            "Stable",
        )

    def test_manifest_and_aliases_identify_installed_version(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            output = Path(raw_temp)
            version_root = output / "0.1"
            (version_root / "search").mkdir(parents=True)
            (version_root / "index.html").write_text(
                '<meta name="generator" content="mkdocs-test">',
                encoding="utf-8",
            )
            (version_root / "search" / "search_index.json").write_text(
                "{}",
                encoding="utf-8",
            )

            bundle.write_bundle_metadata(
                output,
                version="0.1.1",
                docs_version="0.1",
                channel="Testing",
            )
            bundle.validate_bundle(
                output,
                version="0.1.1",
                docs_version="0.1",
                channel="Testing",
            )

            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["canonicalPath"], "/docs/0.1/")
            self.assertEqual(
                manifest["installedAliases"],
                ["/docs/", "/docs/installed/"],
            )
            self.assertIn("/docs/0.1/", (output / "index.html").read_text(encoding="utf-8"))


def _fake_built_tree(output: Path, docs_version: str, pages: tuple[str, ...]) -> None:
    version_root = output / docs_version
    (version_root / "search").mkdir(parents=True)
    (version_root / "search" / "search_index.json").write_text("{}", encoding="utf-8")
    for page in pages:
        index = version_root / page / "index.html"
        index.parent.mkdir(parents=True, exist_ok=True)
        index.write_text('<meta name="generator" content="mkdocs-test">', encoding="utf-8")


class LegacyRedirectTests(unittest.TestCase):
    PAGES = ("", "analyst/chat/", "analyst/case-manager/", "releases/0.2.0/")

    def _bundle(self, output: Path) -> None:
        _fake_built_tree(output, "0.2", self.PAGES)
        bundle.write_bundle_metadata(output, version="0.2.0", docs_version="0.2", channel="Testing")
        written = bundle.write_legacy_redirects(output, docs_version="0.2")
        self.assertEqual(written, len(self.PAGES) * len(bundle.legacy_lines("0.2")))

    def test_the_legacy_line_is_named_and_never_the_current_line(self) -> None:
        self.assertIn("0.1", bundle.LEGACY_DOC_LINES)
        self.assertEqual(bundle.legacy_lines("0.2"), ("0.1",))
        self.assertEqual(bundle.legacy_lines("0.1"), ())

    def test_every_current_page_has_a_redirect_in_the_old_line(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            output = Path(raw_temp)
            self._bundle(output)
            bundle.validate_bundle(output, version="0.2.0", docs_version="0.2", channel="Testing")

            stub = (output / "0.1" / "analyst" / "case-manager" / "index.html").read_text(
                encoding="utf-8"
            )
            self.assertIn(
                '<meta http-equiv="refresh" content="0; url=/docs/0.2/analyst/case-manager/">', stub
            )
            self.assertIn('<link rel="canonical" href="/docs/0.2/analyst/case-manager/">', stub)
            home = (output / "0.1" / "index.html").read_text(encoding="utf-8")
            self.assertIn('url=/docs/0.2/"', home)
            # The script runs before the no-script fallback.
            self.assertLess(stub.index("<script>"), stub.index('http-equiv="refresh"'))

    def test_the_anchored_stub_keeps_the_fragment(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            output = Path(raw_temp)
            self._bundle(output)
            stub = (output / "0.1" / "analyst" / "chat" / "index.html").read_text(encoding="utf-8")
            match = re.search(r"<script>(.*?)</script>", stub)
            self.assertIsNotNone(match)
            script = match.group(1)
            self.assertEqual(script, 'location.replace("/docs/0.2/analyst/chat/" + location.hash)')
            node = shutil.which("node")
            if node is None:
                return
            # Run the exact script against a stand-in location: a stored citation
            # such as /docs/0.1/analyst/chat/#sources must land on #sources.
            driver = (
                "let target = null;"
                "const location = { hash: '#sources', replace(url) { target = url; } };"
                f"{script};"
                "process.stdout.write(target);"
            )
            landed = subprocess.run(
                [node, "-e", driver], check=True, capture_output=True, text=True
            ).stdout
            self.assertEqual(landed, "/docs/0.2/analyst/chat/#sources")

    def test_a_missing_or_wrong_stub_fails_the_bundle_check(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            output = Path(raw_temp)
            self._bundle(output)
            (output / "0.1" / "analyst" / "chat" / "index.html").unlink()
            with self.assertRaisesRegex(RuntimeError, "anchored citation page"):
                bundle.validate_bundle(output, version="0.2.0", docs_version="0.2")
        with tempfile.TemporaryDirectory() as raw_temp:
            output = Path(raw_temp)
            self._bundle(output)
            (output / "0.1" / "releases" / "0.2.0" / "index.html").write_text(
                bundle._redirect_page("/docs/0.2/releases/0.2.0/", "x"), encoding="utf-8"
            )
            with self.assertRaisesRegex(RuntimeError, "does not redirect"):
                bundle.validate_bundle(output, version="0.2.0", docs_version="0.2")

    def test_the_target_can_never_close_the_script(self) -> None:
        script = bundle._fragment_script("/docs/0.2/</script><b>/")
        self.assertTrue(script.startswith("<script>") and script.endswith("</script>"))
        self.assertNotIn("<", script[len("<script>") : -len("</script>")])


if __name__ == "__main__":
    unittest.main()
