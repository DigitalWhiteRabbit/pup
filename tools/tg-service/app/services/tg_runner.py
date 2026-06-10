"""Shared Telethon connection helpers (P5-02).

Centralizes the proxy-kwargs builder that was copy-pasted byte-for-byte across
~10 task modules (dm_campaign, chat_broadcast, invite, join_chats, commenting,
auto_replier, ai_agent, ai_sales, channel, warmup_script). Each module keeps its
thin ``_build_proxy_kwargs`` wrapper delegating here, so call-sites are untouched
and behaviour is identical — this only removes the duplication.

The NO_PROXY guard convention (never connect a proxy-less account over the real
host IP) stays at the call-sites: they check ``"proxy" not in proxy_kwargs`` and
skip. ``build_proxy_kwargs`` returns ``{}`` for a missing / inactive proxy, which
is exactly what that guard keys off.
"""

from __future__ import annotations

from typing import Any


def build_proxy_kwargs(db: Any, proxy_id: str | None) -> dict[str, Any]:
    """Build Telethon proxy kwargs for an account's assigned proxy.

    Returns ``{"proxy": {...}}`` for an ACTIVE proxy, or ``{}`` when the proxy is
    missing / inactive / unset. The empty-dict return is what NO_PROXY guards at
    call-sites rely on to refuse connecting over the real IP.
    """
    if not proxy_id:
        return {}

    import python_socks

    proxy_row = db.execute(
        "SELECT * FROM tg_proxies WHERE id = ?", [proxy_id]
    ).fetchone()
    if not proxy_row or proxy_row["status"] != "ACTIVE":
        return {}

    scheme = (proxy_row["scheme"] or "http").lower()
    if "socks5" in scheme:
        ptype = python_socks.ProxyType.SOCKS5
    elif "socks4" in scheme:
        ptype = python_socks.ProxyType.SOCKS4
    else:
        ptype = python_socks.ProxyType.HTTP

    return {
        "proxy": {
            "proxy_type": ptype,
            "addr": proxy_row["host"],
            "port": int(proxy_row["port"]),
            "username": proxy_row["username"],
            "password": proxy_row["password"],
            "rdns": True,
        }
    }
