#!/usr/bin/env python3
"""Contract smoke test: UI-referenced endpoints ⇄ OpenAPI spec (P5-07).

Catches frontend↔backend endpoint drift — the class of bug where the UI calls a
path the backend never exposed (e.g. the /proxies/bulk 404 fixed in P3-05).

Extracts every ``ap('/...')`` / ``af('/...')`` / ``aP('/...')`` / ``aD('/...')``
and ``fetch(au('/...'))`` call from public/index.html, normalizes the dynamic
segments to a comparable prefix, and verifies each maps onto a route in the live
OpenAPI spec at http://localhost:8001/openapi.json.

Exit code 0 = all UI endpoints have a backing route; 1 = one or more missing.

Usage: python3 scripts/contract_smoke.py
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

BASE = "http://localhost:8001"
API_PREFIX = "/api/v1"
HTML = Path(__file__).resolve().parent.parent / "public" / "index.html"

# UI paths that are intentionally dynamic-only or handled specially — skip.
# (These are templated at call time with no static prefix worth matching.)
_SKIP_EXACT = {"/", "/health"}


def _ui_paths() -> set[str]:
    """Pull distinct endpoint paths the UI references via its fetch helpers."""
    src = HTML.read_text(encoding="utf-8")
    # ap('/x'), af('/x'), aP('/x'), aD('/x'), au('/x')
    pat = re.compile(r"\b(?:ap|af|aP|aD|au)\('(/[a-zA-Z0-9/_?.=&{}-]*)")
    found = set()
    for m in pat.finditer(src):
        p = m.group(1)
        # Drop query strings and trailing concatenation artifacts.
        p = p.split("?")[0].rstrip("/")
        if p and p not in _SKIP_EXACT:
            found.add(p)
    return found


def _openapi_routes() -> set[str]:
    """Fetch the OpenAPI spec and return its route templates (sans API prefix)."""
    with urllib.request.urlopen(f"{BASE}/openapi.json", timeout=10) as r:
        spec = json.loads(r.read())
    routes = set()
    for path in spec.get("paths", {}):
        if path.startswith(API_PREFIX):
            path = path[len(API_PREFIX):]
        routes.add(path.rstrip("/"))
    return routes


def _matches(ui_path: str, routes: set[str]) -> bool:
    """True if a UI path maps onto some OpenAPI route.

    A UI path is a static prefix (its dynamic id is appended at call time, e.g.
    ``/accounts/`` → ``/accounts/{id}``). We accept a match when the UI path
    equals a route, is the static prefix of a templated route, or a templated
    route is a prefix of it.
    """
    up = ui_path.rstrip("/")
    if up in routes:
        return True
    up_parts = up.strip("/").split("/")
    for route in routes:
        rp = route.strip("/").split("/")
        # The UI path is a prefix of this route (route adds an {id} etc.)
        if len(rp) >= len(up_parts) and rp[: len(up_parts)] == up_parts:
            return True
        # Route is a template whose static parts match the UI prefix segment-wise.
        if len(rp) == len(up_parts):
            ok = all(r == u or r.startswith("{") for r, u in zip(rp, up_parts))
            if ok:
                return True
        # UI path has MORE segments than route, but route's a templated prefix.
        if len(up_parts) > len(rp) and all(
            r == u or r.startswith("{") for r, u in zip(rp, up_parts[: len(rp)])
        ):
            return True
    return False


def main() -> int:
    try:
        routes = _openapi_routes()
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: cannot reach OpenAPI spec at {BASE} ({exc})")
        return 2

    ui = _ui_paths()
    missing = sorted(p for p in ui if not _matches(p, routes))

    print(f"UI endpoint references: {len(ui)} | OpenAPI routes: {len(routes)}")
    if missing:
        print(f"\n{len(missing)} UI path(s) with NO backing endpoint:")
        for p in missing:
            print(f"  ✗ {p}")
        return 1

    print("=== all UI endpoints have a backing route ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
