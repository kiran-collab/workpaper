"""Real-browser tests: the app in Chrome, served both ways it ships.

    pytest -m e2e

Each run starts its own servers on free ports: a plain static file server (the static link) and the
FastAPI server (shared journal, findings computed live). The harness pages drive the app through
its test hook and report back; these tests assert on that report.
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

pytestmark = pytest.mark.e2e
ROOT = Path(__file__).resolve().parents[2]
sync_playwright = pytest.importorskip('playwright.sync_api').sync_playwright


def free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait_for(url: str, seconds: float = 30) -> None:
    end = time.time() + seconds
    while time.time() < end:
        try:
            urllib.request.urlopen(url, timeout=2)
            return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f'{url} did not come up')


@pytest.fixture(scope='module', params=['static', 'server'])
def site(request, tmp_path_factory):
    port, tmp = free_port(), tmp_path_factory.mktemp(request.param)
    env = {**os.environ}
    if request.param == 'static':
        # Serve only web/ and the test pages, never the project root (it holds .env).
        (tmp / 'web').symlink_to(ROOT / 'web'); (tmp / 'tests').mkdir(); (tmp / 'tests' / 'e2e').symlink_to(ROOT / 'tests' / 'e2e')
        cmd, app = [sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', str(tmp)], '/web/index.html'
    else:
        env.update(WP_E2E='1', WP_DB=str(tmp / 'journal.db'))
        cmd, app = [sys.executable, '-m', 'uvicorn', 'workpaper.server.app:app', '--port', str(port), '--log-level', 'warning', '--timeout-graceful-shutdown', '2'], '/index.html'
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f'http://127.0.0.1:{port}'
    try:
        wait_for(base + app)
        yield {'mode': request.param, 'base': base, 'app': app}
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:  # a browser's open event stream can hold the server
            proc.kill()


@pytest.fixture(scope='module')
def browser():
    with sync_playwright() as p:
        try:
            b = p.chromium.launch(channel='chrome', headless=True)  # the installed Chrome
        except Exception:
            try:
                b = p.chromium.launch(headless=True)  # Playwright's own build (CI: playwright install chromium)
            except Exception as e:
                pytest.skip(f'no browser available: {e}')
        yield b
        b.close()


def run_harness(browser, site, name: str) -> tuple[str, list[str]]:
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    page, errors = ctx.new_page(), []
    page.on('pageerror', lambda e: errors.append(str(e)[:200]))
    page.on('response', lambda r: r.status >= 400 and 'api/health' not in r.url and errors.append(f'{r.status} {r.url}'))
    page.goto(f"{site['base']}/tests/e2e/{name}.html?app={site['app']}", wait_until='commit')
    page.wait_for_function("document.getElementById('out').textContent.startsWith('DONE')", timeout=300_000)
    out = page.evaluate("document.getElementById('out').textContent")
    ctx.close()
    return out, errors


def test_every_route_renders_for_every_role(browser, site):
    out, errors = run_harness(browser, site, 'smoke')
    assert out.strip().endswith('no errors'), out
    assert not errors


def test_full_workflow_from_findings_to_frozen_return(browser, site):
    if site['mode'] == 'server':
        urllib.request.urlopen(urllib.request.Request(site['base'] + '/api/events', method='DELETE', headers={'X-User': 'st-05'}))
    out, errors = run_harness(browser, site, 'flow')
    assert 'proposed 22; partner-required 9' in out
    assert 'workpaper fed tax 72478 (engine 81962) bal -4264; CA tax 13176 bal -10454' in out
    assert 'self-approve toast: ⛔ Firm rule: you may not approve your own adjustment' in out
    assert 'transmit2: Accepted' in out and 'frozen=true' in out
    assert 'after freeze adjust: ⛔ Return is frozen' in out
    assert 'marcus sees: SSN •••-••-3390' in out
    assert not errors
