#!/usr/bin/env python3
"""Playwright regression: visit all 26 SPA screens, flag JS/console/network errors.

Mirrors the manual DEBT-2.4 / dispatch-fail-fast verification sweeps. Pass means
each screen renders, no uncaught JS error, no console error, and no failed
(non-2xx/3xx) API request to our own backend.

Usage: .venv/bin/python scripts/regression_screens.py
"""
from __future__ import annotations

import sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8001"
TOKEN = "dev-admin-token-12345"

SCREENS = [
    "dashboard", "accounts", "proxies", "parser", "audiences", "channels",
    "phone-checker", "ai-promoter", "arena", "knowledge-base", "ai-sales",
    "neuro-commenting", "auto-replier", "warmup", "dm-campaign", "chat-broadcast",
    "join-chats", "inviting", "templates", "boost", "stories-boost", "cloner",
    "create-channels", "converter", "messenger", "settings",
]


def main() -> int:
    results: list[tuple[str, bool, list[str]]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        # Pre-seed token + workspace so the SPA boots authenticated.
        ctx.add_init_script(
            f"localStorage.setItem('tg-admin-token','{TOKEN}');"
            "localStorage.setItem('tg-theme','light');"
        )
        page = ctx.new_page()

        page.goto(BASE, wait_until="networkidle")

        for sec in SCREENS:
            errs: list[str] = []

            def on_console(msg, _errs=errs):
                if msg.type == "error":
                    _errs.append(f"console.error: {msg.text[:200]}")

            def on_pageerror(exc, _errs=errs):
                _errs.append(f"pageerror: {str(exc)[:200]}")

            def on_response(resp, _errs=errs):
                # Only flag failures from our own backend API.
                if "/api/" in resp.url and resp.status >= 400:
                    _errs.append(f"http {resp.status}: {resp.url.split(BASE)[-1]}")

            page.on("console", on_console)
            page.on("pageerror", on_pageerror)
            page.on("response", on_response)

            page.evaluate(f"location.hash = '{sec}';")
            page.wait_for_timeout(1200)  # let async loads + render settle
            # Sanity: main content container exists and is non-empty.
            try:
                html = page.eval_on_selector("#mc", "el => el.innerHTML.length")
            except Exception:
                html = 0
            if not html:
                errs.append("empty #mc (screen did not render)")

            page.remove_listener("console", on_console)
            page.remove_listener("pageerror", on_pageerror)
            page.remove_listener("response", on_response)

            ok = not errs
            results.append((sec, ok, errs))
            mark = "OK " if ok else "FAIL"
            print(f"[{mark}] {sec}" + ("" if ok else f"  -> {errs}"))

        browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n=== {passed}/{total} screens clean ===")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
