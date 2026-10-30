"""Paths and settings, in one place.

Defaults assume the repository layout (web/ beside src/). Every path can be overridden with an
environment variable, which is how a deployment points at its own data and database. A .env file in
the project root is read once at startup; variables already set in the environment win.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(os.environ.get('WP_ROOT', Path(__file__).resolve().parents[2]))


def load_env() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(ROOT / '.env', override=False)


load_env()

WEB_DIR = Path(os.environ.get('WP_WEB_DIR', ROOT / 'web'))
PACKET_PATH = Path(os.environ.get('WP_PACKET', WEB_DIR / 'data' / 'okafor_lindqvist_2025_packet.json'))
FINDINGS_PATH = Path(os.environ.get('WP_FINDINGS', WEB_DIR / 'data' / 'findings.json'))
DB_PATH = Path(os.environ.get('WP_DB', ROOT / 'var' / 'journal.db'))
EVAL_DIR = Path(os.environ.get('WP_EVAL_DIR', ROOT / 'var' / 'eval_results'))
E2E_DIR = ROOT / 'tests' / 'e2e'

DEMO = os.environ.get('WP_DEMO', '1') == '1'          # anyone may load demo history or reset
SERVE_TEST_PAGES = os.environ.get('WP_E2E', '0') == '1'  # expose tests/e2e pages (test runs only)
