"""Round 16 static guards (SPEC §3.6, §3.5 #3).

* ``engine/risk.py`` and the source of ``case_manager.decide()`` are byte-identical to
  the round's starting commit ``3cd362c``: Round 16 records risk inputs and the decision
  gate BESIDE them and never edits them.
* The new pure modules (``engine/risk_explain.py``, ``engine/investigation_registry.py``,
  and later ``engine/sla_reading.py`` and ``engine/stats.py``) import nothing from
  ``engine/case_manager.py``, and the two decision modules import none of them (the
  pattern of ``test_overhaul_b2_autopilot.py::test_new_producer_modules_never_import_decide``).
  A listed module that does not exist yet is checked when it lands.
* The investigation registry is imported by no agent module other than
  ``agents/pipeline.py`` and by no tool.
"""

from __future__ import annotations

import ast
import hashlib
import inspect
from pathlib import Path

from app.engine.case_manager import decide

APP = Path(__file__).resolve().parents[1] / "app"

#: SHA-256 of ``backend/app/engine/risk.py`` at ``3cd362c``.
RISK_PY_SHA256 = "eedefbf740f5082c211c565b3774d49f553f43d513ed55bffed940a9db19b42d"
#: SHA-256 of ``inspect.getsource(decide)`` (UTF-8) at ``3cd362c``.
DECIDE_SOURCE_SHA256 = "ddd835c03eb2815182e62f78f80646ffeb8dd636b466f4a142760629573faa50"

#: The Round 16 pure modules that must never reach the decision core.
ROUND16_PURE_MODULES = ("risk_explain", "investigation_registry", "sla_reading", "stats")


def _import_lines(path: Path) -> list[str]:
    """Every imported name of ``path``, as ``module`` or ``module.name`` (parsed, so a
    docstring that says "from ``engine/case_manager.py``" is not an import)."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            module = "." * node.level + (node.module or "")
            names.append(module)
            names.extend(f"{module}.{alias.name}" for alias in node.names)
    return names


def test_risk_py_is_byte_identical_to_the_round_start() -> None:
    digest = hashlib.sha256((APP / "engine" / "risk.py").read_bytes()).hexdigest()
    assert digest == RISK_PY_SHA256


def test_decide_source_is_byte_identical_to_the_round_start() -> None:
    digest = hashlib.sha256(inspect.getsource(decide).encode("utf-8")).hexdigest()
    assert digest == DECIDE_SOURCE_SHA256


def test_the_pure_round16_modules_never_import_the_decision_core() -> None:
    checked = 0
    for name in ROUND16_PURE_MODULES:
        path = APP / "engine" / f"{name}.py"
        if not path.exists():
            continue  # lands in a later package; checked from then on
        checked += 1
        for line in _import_lines(path):
            assert "case_manager" not in line, f"{name}.py imports the decision core: {line!r}"
    # The two WP01 modules exist from the first merge.
    assert checked >= 2


def test_the_decision_modules_import_none_of_the_round16_modules() -> None:
    for module in ("case_manager.py", "risk.py"):
        for line in _import_lines(APP / "engine" / module):
            for name in ROUND16_PURE_MODULES:
                assert name not in line, f"engine/{module} imports {name}: {line!r}"


def test_only_the_pipeline_imports_the_investigation_registry() -> None:
    offenders: list[str] = []
    for root in (APP / "agents", APP / "tools"):
        for path in sorted(root.rglob("*.py")):
            if path == APP / "agents" / "pipeline.py":
                continue
            if any("investigation_registry" in line for line in _import_lines(path)):
                offenders.append(str(path.relative_to(APP)))
    assert offenders == []
