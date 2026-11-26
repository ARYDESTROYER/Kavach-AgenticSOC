"""Round 16 WP16P: records that must follow the code (SPEC 4.6 WP16).

* ``docs/reference/api.md`` states how many paths the committed OpenAPI snapshot
  (``webui/openapi.json``) holds; the number follows the snapshot.
* ``docs/development/ui-standard.md`` records, beside the WCAG 2.4.11 band rule, that a pinned
  leading table column pads its horizontal scroller (technique C43), as ``DataTable`` does.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import app

REPO_ROOT = Path(app.__file__).resolve().parents[2]
API_REFERENCE = REPO_ROOT / "docs" / "reference" / "api.md"
OPENAPI = REPO_ROOT / "webui" / "openapi.json"
UI_STANDARD = REPO_ROOT / "docs" / "development" / "ui-standard.md"
DATA_TABLE = REPO_ROOT / "webui" / "src" / "soc" / "components" / "DataTable.tsx"


def _paragraphs(text: str) -> list[str]:
    return [" ".join(block.split()) for block in re.split(r"\n\s*\n", text) if block.strip()]


def test_the_api_reference_counts_every_path_of_the_openapi_snapshot() -> None:
    paths = json.loads(OPENAPI.read_text(encoding="utf-8"))["paths"]
    text = " ".join(API_REFERENCE.read_text(encoding="utf-8").split())
    match = re.search(r"OpenAPI snapshot contains ([\d,]+) paths", text)
    assert match, "docs/reference/api.md no longer states the snapshot's path count"
    assert int(match.group(1).replace(",", "")) == len(paths), (
        f"docs/reference/api.md says {match.group(1)} paths; webui/openapi.json has {len(paths)}"
    )


def test_the_ui_standard_records_the_sticky_column_scroll_padding() -> None:
    # The code fact the standard describes.
    table = DATA_TABLE.read_text(encoding="utf-8")
    assert "scroll-padding-inline-start" in table and "stickyFirstColumn" in table
    paragraphs = _paragraphs(UI_STANDARD.read_text(encoding="utf-8"))
    band = next(i for i, p in enumerate(paragraphs) if p.startswith("Nothing lands under a sticky page band"))
    rule = next(
        (i for i, p in enumerate(paragraphs) if "scroll-padding-inline-start" in p),
        None,
    )
    assert rule is not None, "ui-standard.md does not record the pinned column's scroll padding"
    assert rule == band + 1, "the pinned column rule sits right after the 2.4.11 band rule"
    text = paragraphs[rule]
    for phrase in ("2.4.11", "C43", "stickyFirstColumn", "selection column", "Shift+Tab"):
        assert phrase in text, phrase
    # No en dash, em dash or no-break space (the round's character rule).
    assert not any(ch in text for ch in ("\N{EN DASH}", "\N{EM DASH}", "\N{NO-BREAK SPACE}"))
