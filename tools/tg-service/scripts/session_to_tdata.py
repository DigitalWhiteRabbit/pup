"""Convert a Telethon .session file into a Telegram Desktop tdata folder.

After running this, you can plug the resulting tdata folder into Telegram
Desktop and log in to the account as if you had typed the SMS code.

Usage:
    PYTHONPATH=. .venv/bin/python scripts/session_to_tdata.py \
        data/exports/<phone>.session <app_id> <app_hash>

The output is created next to the source as ``tdata-<phone>/``.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path


async def main(session_path: str, app_id: int, app_hash: str) -> None:
    from opentele.api import UseCurrentSession
    from opentele.td import TDesktop
    from opentele.tl import TelegramClient

    src = Path(session_path).expanduser().resolve()
    if not src.exists():
        print(f"ERROR: session file not found: {src}")
        sys.exit(1)

    out_dir = src.parent / f"tdata-{src.stem}"
    out_dir.mkdir(parents=True, exist_ok=True)
    tdata_dir = out_dir / "tdata"
    # opentele writes the tdata files into the given path
    print(f"Source session : {src}")
    print(f"Output tdata   : {tdata_dir}")

    # Use UseCurrentSession so opentele reuses the same authKey — no SMS prompt.
    client = TelegramClient(str(src.with_suffix("")), api_id=app_id, api_hash=app_hash)
    await client.connect()
    tdesk = await client.ToTDesktop(flag=UseCurrentSession)
    tdesk.SaveTData(str(tdata_dir))
    await client.disconnect()

    print()
    print("SUCCESS: tdata is ready.")
    print()
    print("How to plug it into Telegram Desktop:")
    print("  1. Quit Telegram Desktop completely.")
    print("  2. Back up your CURRENT tdata folder (Telegram Desktop → Settings → Advanced")
    print("     → Show working folder → ‘tdata’). Move it aside if you don’t want to lose")
    print("     your main account.")
    print(f"  3. Copy the contents of {tdata_dir} into the working folder.")
    print("  4. Start Telegram Desktop — it will open authorised as this account.")
    print()
    print("If you keep multiple TG Desktop profiles via ‘portable’ mode (-many flag),")
    print("you can run a fresh portable copy pointing at this tdata folder directly.")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("usage: session_to_tdata.py <session.path> <app_id> <app_hash>")
        sys.exit(1)
    asyncio.run(main(sys.argv[1], int(sys.argv[2]), sys.argv[3]))
