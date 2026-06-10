"""Celery task: crawl a whole website into the Knowledge Base (JS-rendered).

Given a start URL, breadth-first crawl every same-(registered-)domain HTML page
using a headless Chromium browser (Playwright sync API), extract the RENDERED
text, and persist ONE KB document per page (reusing the KB document + chunk
insertion path).

Rendering with a real browser is the key win over the old httpx+BeautifulSoup
approach: client-side-rendered (SPA) content and JS-injected links are now
visible, so single-page-app sites are crawled correctly.

The Celery worker runs sync/prefork, so we use ``playwright.sync_api`` (NOT the
async API).

SSRF safety is enforced on EVERY URL fetched (start + discovered + redirect
target): only http/https schemes are allowed, and the hostname must resolve
exclusively to globally-routable IPs — loopback, private, link-local (incl. the
cloud metadata endpoint 169.254.169.254) and other non-global addresses are
rejected.

A hard safety cap of 200 pages prevents infinite loops / abuse even though the
crawler otherwise has no functional page limit.
"""

from __future__ import annotations

import random
import socket
import time
from ipaddress import ip_address
from typing import Any
from urllib.parse import urldefrag, urlparse

import structlog

from app.core.database import get_db
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Hard safety cap — sites are expected to be small, but never crawl more than
# this many pages (protects against infinite loops / malicious link farms).
SAFETY_CAP_PAGES = 200

# Playwright navigation timeout (ms) and a short settle wait for late JS.
NAV_TIMEOUT_MS = 20_000
JS_SETTLE_MS = 600
MIN_TEXT_LEN = 40  # skip pages with near-empty extracted text

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 PUP-KB-Crawler/1.0"
)

# Asset / non-HTML extensions to skip when discovering links.
_SKIP_EXTENSIONS = (
    ".pdf",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".svg",
    ".ico",
    ".bmp",
    ".tiff",
    ".zip",
    ".rar",
    ".7z",
    ".tar",
    ".gz",
    ".bz2",
    ".mp4",
    ".webm",
    ".mov",
    ".avi",
    ".mkv",
    ".mp3",
    ".wav",
    ".ogg",
    ".flac",
    ".css",
    ".js",
    ".json",
    ".xml",
    ".rss",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".otf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".csv",
    ".exe",
    ".dmg",
    ".apk",
)

_ALLOWED_SCHEMES = ("http", "https")


# ---------------------------------------------------------------------------
# SSRF protection
# ---------------------------------------------------------------------------


class SSRFError(ValueError):
    """Raised when a URL fails SSRF validation."""


def _is_safe_ip(ip_str: str) -> bool:
    """Return True only for globally-routable IPs.

    Rejects loopback (127/8, ::1), private (10/8, 172.16/12, 192.168/16,
    fc00::/7), link-local (169.254/16 incl. cloud metadata 169.254.169.254),
    and any other non-global / reserved / multicast / unspecified address.
    """
    try:
        ip = ip_address(ip_str)
    except ValueError:
        return False

    if (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return False

    # is_global is the strongest check (also catches shared/benchmark ranges).
    return bool(getattr(ip, "is_global", True))


def validate_url_ssrf(url: str) -> str:
    """Validate *url* against SSRF rules; return it on success, else raise.

    Checks:
      1. scheme is http/https only (rejects file://, ftp://, gopher://, …)
      2. a hostname is present
      3. EVERY IP the hostname resolves to is globally routable (rejects
         loopback / private / link-local / metadata / reserved)

    Raises :class:`SSRFError` on any failure.
    """
    parsed = urlparse(url)

    scheme = (parsed.scheme or "").lower()
    if scheme not in _ALLOWED_SCHEMES:
        raise SSRFError(f"Disallowed URL scheme: {scheme or '(none)'}")

    host = parsed.hostname
    if not host:
        raise SSRFError("URL has no hostname")

    # Resolve all addresses for this host; reject if ANY is non-global.
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise SSRFError(f"DNS resolution failed for {host}: {exc}") from exc

    addrs = {info[4][0] for info in infos}
    if not addrs:
        raise SSRFError(f"No addresses resolved for {host}")

    for addr in addrs:
        if not _is_safe_ip(addr):
            raise SSRFError(f"Host {host} resolves to non-global IP {addr}")

    return url


# ---------------------------------------------------------------------------
# URL / domain helpers
# ---------------------------------------------------------------------------


def _registered_domain(netloc: str) -> str:
    """Normalise a netloc to a comparable registered domain.

    Strips a leading ``www.`` and any port so ``www.example.com:443`` and
    ``example.com`` compare equal.
    """
    host = netloc.lower().split("@")[-1]  # drop any userinfo
    host = host.split(":")[0]  # drop port
    if host.startswith("www."):
        host = host[4:]
    return host


def _same_domain(url: str, base_domain: str) -> bool:
    """Return True if *url*'s host is the same registered domain as *base_domain*."""
    try:
        return _registered_domain(urlparse(url).netloc) == base_domain
    except Exception:  # noqa: BLE001
        return False


def _is_skippable_asset(url: str) -> bool:
    """Return True for URLs whose path ends in a known non-HTML asset extension."""
    path = urlparse(url).path.lower()
    return path.endswith(_SKIP_EXTENSIONS)


def _clean_link(href: str) -> str | None:
    """Normalise a browser-resolved (already absolute) *href*.

    The browser resolves ``a.href`` to an absolute URL for us, so we only need
    to drop fragments and reject non-http(s) / mailto / tel / javascript links.
    Returns a clean absolute URL or ``None`` to skip.
    """
    href = (href or "").strip()
    if not href:
        return None

    low = href.lower()
    if low.startswith(("mailto:", "tel:", "javascript:", "data:", "#")):
        return None

    absolute, _frag = urldefrag(href)  # drop #fragment
    if not absolute:
        return None

    scheme = urlparse(absolute).scheme.lower()
    if scheme not in _ALLOWED_SCHEMES:
        return None

    return absolute


def _clean_text(raw: str) -> str:
    """Collapse whitespace in rendered innerText (strip blank lines)."""
    lines = (line.strip() for line in (raw or "").splitlines())
    return "\n".join(line for line in lines if line)


# ---------------------------------------------------------------------------
# Job-row updates
# ---------------------------------------------------------------------------


def _set_running(db: Any, job_id: str) -> None:
    db.execute(
        "UPDATE tg_kb_crawl_jobs SET status = 'RUNNING', started_at = datetime('now') "
        "WHERE id = ?",
        [job_id],
    )
    db.commit()


def _update_progress(
    db: Any,
    job_id: str,
    *,
    pages_found: int,
    pages_done: int,
    documents_created: int,
) -> None:
    db.execute(
        "UPDATE tg_kb_crawl_jobs "
        "SET pages_found = ?, pages_done = ?, documents_created = ? WHERE id = ?",
        [pages_found, pages_done, documents_created, job_id],
    )
    db.commit()


def _finish_done(
    db: Any,
    job_id: str,
    *,
    pages_found: int,
    pages_done: int,
    documents_created: int,
    error: str | None,
) -> None:
    db.execute(
        "UPDATE tg_kb_crawl_jobs "
        "SET status = 'DONE', pages_found = ?, pages_done = ?, documents_created = ?, "
        "error = ?, finished_at = datetime('now') WHERE id = ?",
        [pages_found, pages_done, documents_created, error, job_id],
    )
    db.commit()


def _finish_failed(db: Any, job_id: str, error: str) -> None:
    db.execute(
        "UPDATE tg_kb_crawl_jobs "
        "SET status = 'FAILED', error = ?, finished_at = datetime('now') WHERE id = ?",
        [error[:1000], job_id],
    )
    db.commit()


# ---------------------------------------------------------------------------
# Per-page rendering + extraction (Playwright)
# ---------------------------------------------------------------------------


def _render_page(page: Any, page_url: str) -> tuple[str, str, str, list[str]]:
    """Navigate *page* to *page_url* and extract rendered content.

    Returns ``(final_url, title, clean_text, discovered_links)`` where:
      - ``final_url`` is the URL after any redirects (caller re-validates it),
      - ``title`` is ``document.title`` (falls back to the URL path),
      - ``clean_text`` is ``innerText`` of <body> with whitespace collapsed,
      - ``discovered_links`` are absolute hrefs already resolved by the browser.
    """
    page.goto(page_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)

    # Give late client-side rendering a brief chance to settle. networkidle is
    # best-effort: SPAs with long-polling never reach it, so we don't fail on it.
    try:
        page.wait_for_load_state("networkidle", timeout=NAV_TIMEOUT_MS)
    except Exception:  # noqa: BLE001 — networkidle never reached is fine
        pass
    page.wait_for_timeout(JS_SETTLE_MS)

    final_url = page.url

    # Title from the rendered document, fallback to the URL path / host.
    title = (page.title() or "").strip()
    if not title:
        path = urlparse(final_url).path.strip("/")
        title = path or urlparse(final_url).netloc or final_url

    # Rendered body text — captures JS-injected content.
    try:
        body_text = page.inner_text("body")
    except Exception:  # noqa: BLE001 — pages without a <body> (rare)
        body_text = ""
    text = _clean_text(body_text)

    # Discover links from the RENDERED DOM. e.href is the browser's already
    # absolute resolution, so SPA links injected by JS are visible here.
    raw_hrefs = page.eval_on_selector_all(
        "a[href]", "els => els.map(e => e.href)"
    )
    links: list[str] = []
    for href in raw_hrefs or []:
        cleaned = _clean_link(href)
        if cleaned:
            links.append(cleaned)

    return final_url, title[:500], text, links


# ---------------------------------------------------------------------------
# Core crawl
# ---------------------------------------------------------------------------


def _crawl(workspace_id: str, job_id: str, start_url: str) -> dict[str, Any]:
    """BFS-crawl the JS-rendered site and persist one KB document per page."""
    # Imported here to avoid an API → tasks import cycle at module load.
    from app.api.v1.knowledge_base import _persist_document

    # Lazy import: keep the worker importable even if Playwright/chromium is
    # missing — we surface a clear FAILED status instead of crashing.
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # noqa: BLE001
        db = get_db(workspace_id)
        _finish_failed(
            db,
            job_id,
            f"Playwright/chromium not installed: {exc}. "
            "Run `.venv/bin/pip install playwright && .venv/bin/playwright install chromium`.",
        )
        log.error("kb_crawl_playwright_missing", job_id=job_id, error=str(exc))
        return {"status": "FAILED", "error": "Playwright/chromium not installed"}

    db = get_db(workspace_id)
    _set_running(db, job_id)

    base_domain = _registered_domain(urlparse(start_url).netloc)
    # "site" groups all pages of one crawl together in the UI (root netloc,
    # normalized without www / port).
    site = base_domain

    queue: list[str] = [start_url]
    visited: set[str] = set()
    pages_done = 0
    documents_created = 0
    cap_hit = False

    browser = None
    try:
        try:
            pw = sync_playwright().start()
        except Exception as exc:  # noqa: BLE001 — driver/launch failure
            _finish_failed(
                db,
                job_id,
                f"Playwright/chromium not installed or failed to start: {exc}",
            )
            log.error("kb_crawl_playwright_start_failed", job_id=job_id, error=str(exc))
            return {"status": "FAILED", "error": "Playwright/chromium not installed"}

        try:
            browser = pw.chromium.launch(headless=True)
        except Exception as exc:  # noqa: BLE001 — chromium binary missing
            _finish_failed(
                db,
                job_id,
                f"Playwright/chromium not installed (launch failed): {exc}. "
                "Run `.venv/bin/playwright install chromium`.",
            )
            log.error("kb_crawl_chromium_launch_failed", job_id=job_id, error=str(exc))
            pw.stop()
            return {"status": "FAILED", "error": "Playwright/chromium not installed"}

        # One context + one reused page for the whole job (fast; no per-page
        # browser startup cost).
        context = browser.new_context(user_agent=_USER_AGENT, ignore_https_errors=False)
        page = context.new_page()
        page.set_default_navigation_timeout(NAV_TIMEOUT_MS)

        while queue:
            if len(visited) >= SAFETY_CAP_PAGES:
                cap_hit = True
                log.warning(
                    "kb_crawl_safety_cap",
                    job_id=job_id,
                    workspace_id=workspace_id,
                    cap=SAFETY_CAP_PAGES,
                )
                break

            page_url = queue.pop(0)
            if page_url in visited:
                continue
            visited.add(page_url)

            try:
                # SSRF-validate BEFORE navigating.
                validate_url_ssrf(page_url)

                final_url, title, text, links = _render_page(page, page_url)

                # Re-validate the FINAL URL after redirects (SSRF via redirect)
                # BEFORE we save or trust its links.
                if final_url != page_url:
                    validate_url_ssrf(final_url)

                # Persist one KB document per page (skip near-empty pages).
                if text and len(text) >= MIN_TEXT_LEN:
                    _persist_document(
                        db,
                        title,
                        text,
                        metadata={
                            "source": "crawl",
                            "site": site,
                            "url": final_url,
                            "crawl_job_id": job_id,
                        },
                    )
                    documents_created += 1
                else:
                    log.debug("kb_crawl_skip_empty", job_id=job_id, url=page_url)

                # Enqueue same-domain, non-asset, unseen links.
                for link in links:
                    if link in visited:
                        continue
                    if not _same_domain(link, base_domain):
                        continue
                    if _is_skippable_asset(link):
                        continue
                    if link not in queue:
                        queue.append(link)

                pages_done += 1

            except SSRFError as exc:
                log.warning("kb_crawl_ssrf_blocked", job_id=job_id, url=page_url, error=str(exc))
                pages_done += 1
            except Exception as exc:  # noqa: BLE001 — one bad page must not kill the crawl
                log.warning(
                    "kb_crawl_page_error",
                    job_id=job_id,
                    url=page_url,
                    error=str(exc)[:300],
                )
                pages_done += 1

            # Persist progress as we go (pages_found = queued + visited).
            pages_found = len(visited) + len(queue)
            _update_progress(
                db,
                job_id,
                pages_found=pages_found,
                pages_done=pages_done,
                documents_created=documents_created,
            )

            # Politeness delay so we don't hammer the target site.
            time.sleep(random.uniform(0.3, 1.0))
    finally:
        # Always tear down the browser + driver.
        try:
            if browser is not None:
                browser.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            pw.stop()  # type: ignore[possibly-undefined]
        except Exception:  # noqa: BLE001
            pass

    pages_found = len(visited) + len(queue)
    error_note = f"stopped at safety cap {SAFETY_CAP_PAGES}" if cap_hit else None
    _finish_done(
        db,
        job_id,
        pages_found=pages_found,
        pages_done=pages_done,
        documents_created=documents_created,
        error=error_note,
    )

    log.info(
        "kb_crawl_complete",
        job_id=job_id,
        workspace_id=workspace_id,
        pages_done=pages_done,
        documents_created=documents_created,
        cap_hit=cap_hit,
    )

    # Best-effort: the crawl added many docs — check the whole base once.
    if documents_created > 0:
        try:
            celery_app.send_task(
                "pup_tg.kb_check_conflicts",
                args=[workspace_id, None],
                queue="pup_tg_default",
            )
            log.info(
                "kb_crawl_conflict_check_dispatched",
                job_id=job_id,
                workspace_id=workspace_id,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "kb_crawl_conflict_check_dispatch_failed",
                job_id=job_id,
                error=str(exc)[:300],
            )

    return {
        "status": "DONE",
        "pages_found": pages_found,
        "pages_done": pages_done,
        "documents_created": documents_created,
        "cap_hit": cap_hit,
    }


# ---------------------------------------------------------------------------
# Celery task
# ---------------------------------------------------------------------------


@celery_app.task(name="pup_tg.kb_crawl", bind=True, max_retries=0)
def kb_crawl(self, workspace_id: str, job_id: str, url: str) -> dict[str, Any]:  # type: ignore[override]
    """Crawl a JS-rendered website and store one KB document per page.

    Synchronous Celery task. Renders each page with headless Chromium
    (Playwright sync API), SSRF-checks every URL, BFS over same-domain HTML
    pages (hard cap 200), and is tolerant of per-page errors.
    """
    log.info(
        "kb_crawl_task_started",
        workspace_id=workspace_id,
        job_id=job_id,
        url=url,
        celery_task_id=self.request.id,
    )
    try:
        return _crawl(workspace_id, job_id, url)
    except Exception as exc:  # noqa: BLE001
        log.error(
            "kb_crawl_task_crashed",
            workspace_id=workspace_id,
            job_id=job_id,
            error=str(exc),
            exc_info=True,
        )
        try:
            db = get_db(workspace_id)
            _finish_failed(db, job_id, f"Task crashed: {str(exc)[:500]}")
        except Exception:  # noqa: BLE001
            pass
        return {"status": "FAILED", "error": f"Task crashed: {str(exc)[:300]}"}
