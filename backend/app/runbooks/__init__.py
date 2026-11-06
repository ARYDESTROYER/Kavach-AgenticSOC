"""The built-in runbook library, shipped as package data.

``library/*.md`` holds the 12 built-in runbooks (Round 14 SPEC §4.10.14), loaded once
and cached by :func:`app.engine.runbook_model.load_builtin_runbooks` and never stored.
Operator runbooks live in the ``runbook_library`` KV namespace instead.
"""
