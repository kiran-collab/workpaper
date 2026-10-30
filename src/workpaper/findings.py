"""The checks' findings across the season, for the app to show.

The app does not compute findings; workpaper.checks does. Served by the FastAPI server, the app gets
them live; served as static files (a plain link), it reads web/data/findings.json. Rebuild that file
after changing a check (a test fails if it is out of date):

    workpaper build-findings
"""
from __future__ import annotations

import json

from .checks import load_packet, season
from .config import FINDINGS_PATH


def build(packet: dict | None = None) -> dict:
    packet = packet if packet is not None else load_packet()
    return {'client': packet['packet']['client_id'], **season(packet)}


def write(path=FINDINGS_PATH) -> dict:
    data = build()
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    return data
