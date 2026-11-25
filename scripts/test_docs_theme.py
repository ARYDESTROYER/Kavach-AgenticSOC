"""Focused contracts for the versioned Help Center's established visual shell."""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
#: The installed documentation line, derived from VERSION as the bundler does.
DOCS_LINE = ".".join(
    (ROOT / "VERSION").read_text(encoding="utf-8").strip().split("-", 1)[0].split(".")[:2]
)


class DocsThemeContractTests(unittest.TestCase):
    def test_help_center_preserves_the_established_shoo_visual_language(self) -> None:
        css = (ROOT / "docs/stylesheets/extra.css").read_text(encoding="utf-8")
        override = (ROOT / "overrides/main.html").read_text(encoding="utf-8")
        config = (ROOT / "mkdocs.yml").read_text(encoding="utf-8")

        self.assertIn("Shoo-inspired documentation shell", css)
        self.assertIn("--tlsoc-accent: #ccff00", css)
        self.assertIn("--tlsoc-bg: #0a0a0a", css)
        self.assertIn('"Space Mono"', css)
        self.assertIn('"Unbounded"', css)
        self.assertIn("body[data-md-color-scheme=\"slate\"]::before", css)
        self.assertIn("@keyframes tlsoc-marquee-scroll", css)
        self.assertIn("fonts.googleapis.com", override)
        self.assertIn("fonts.gstatic.com", override)
        self.assertEqual(2, len(re.findall(r"^\s+accent: lime$", config, re.MULTILINE)))
        self.assertNotRegex(config, r"^\s+accent: deep-purple$")

    def test_console_theme_bridge_covers_light_dark_and_system(self) -> None:
        override = (ROOT / "overrides/main.html").read_text(encoding="utf-8")
        javascript = (ROOT / "docs/javascripts/extra.js").read_text(encoding="utf-8")
        palette = (ROOT / "overrides/partials/palette.html").read_text(encoding="utf-8")

        self.assertIn('localStorage.getItem("soc.theme")', override)
        self.assertIn('mode = "system"', override)
        self.assertIn('matchMedia("(prefers-color-scheme: dark)")', override)
        self.assertIn('root.dataset.tlsocTheme = dark ? "dark" : "light"', override)
        self.assertIn('__md_set("__palette"', override)
        self.assertIn('const CONSOLE_THEME_KEY = "soc.theme"', javascript)
        self.assertIn("window.localStorage.setItem(CONSOLE_THEME_KEY, mode)", javascript)
        self.assertIn('window.fetch("/api/prefs/user"', javascript)
        self.assertIn('body: JSON.stringify({ theme_mode: mode })', javascript)
        self.assertIn('readConsoleTheme() === "system"', javascript)
        self.assertIn('event.key === CONSOLE_THEME_KEY', javascript)
        self.assertIn('aria-pressed="true"', palette)

    def test_prepaint_bridge_is_built_before_the_document_body(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "site"
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/run_docs_bundle.py"),
                    "--output",
                    str(output),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)

            index = (output / DOCS_LINE / "index.html").read_text(encoding="utf-8")
            head_end = index.index("</head>")
            body_start = index.index("<body")
            bridge = index.index('localStorage.getItem("soc.theme")')
            palette_engine = index.index('var palette=__md_get("__palette")')

            self.assertLess(bridge, head_end)
            self.assertLess(head_end, body_start)
            self.assertLess(bridge, palette_engine)
            self.assertIn('data-md-color-accent="lime"', index)
            self.assertIn("fonts.googleapis.com", index)
            self.assertIn("family=Space+Mono", index)


if __name__ == "__main__":
    unittest.main()
