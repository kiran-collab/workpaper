"""FastAPI backend for the workpaper: one append-only journal shared by everyone.

The static app keeps its journal in each browser. This server replaces that with a single
SQLite-backed event log, so people on different machines work on the same workpaper:

    GET    /api/health            packet hash, event count
    GET    /api/users             who can act, with roles
    GET    /api/events?after=N    the journal (server order)
    POST   /api/events            append events; permissions are re-checked here (rules.py)
    DELETE /api/events            reset (demo mode or firm administrator)
    POST   /api/presence          who is looking at what
    GET    /api/stream            server-sent events: appends, resets, presence

The packet is served byte for byte as delivered, and the app itself is served from /, so one
command runs everything:

    uvicorn server.app:app --port 8002

Identity is a demo shortcut: the browser names the acting person in an X-User header and the
server checks that person exists and holds the permission. Real sign-in would replace the header.
WP_DEMO=1 (default) lets anyone load the demo history or reset; set WP_DEMO=0 to restrict those
to the firm administrator.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .rules import Denied, State, check, users_of

ROOT = Path(__file__).resolve().parent.parent
PACKET_PATH = ROOT / 'okafor_lindqvist_2025_packet.json'
DB_PATH = Path(os.environ.get('WP_DB', ROOT / 'server' / 'data' / 'journal.db'))
DEMO = os.environ.get('WP_DEMO', '1') == '1'

PACKET_BYTES = PACKET_PATH.read_bytes()
PACKET = json.loads(PACKET_BYTES)
PACKET_SHA = hashlib.sha256(PACKET_BYTES).hexdigest()
USERS = users_of(PACKET)
CLIENT_ID = PACKET['packet']['client_id']


# ---------------------------------------------------------------- storage
class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('''CREATE TABLE IF NOT EXISTS events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, client TEXT NOT NULL,
            at TEXT NOT NULL, clock TEXT, actor TEXT NOT NULL, batch TEXT, type TEXT NOT NULL, payload TEXT NOT NULL)''')
        self.db.commit()
        self.lock = threading.Lock()

    @staticmethod
    def _row(r) -> dict:
        return {'seq': r[0], 'id': r[1], 'at': r[3], 'clock': r[4], 'actor': r[5], 'batch': r[6], 'type': r[7], 'payload': json.loads(r[8])}

    def all(self, after: int = 0) -> list[dict]:
        return [self._row(r) for r in self.db.execute('SELECT * FROM events WHERE client = ? AND seq > ? ORDER BY seq', (CLIENT_ID, after))]

    def append(self, events: list[dict]) -> list[dict]:
        """Store events atomically; ids already present are skipped (a retried request is harmless)."""
        out = []
        with self.lock, self.db:
            for e in events:
                cur = self.db.execute('INSERT OR IGNORE INTO events (id, client, at, clock, actor, batch, type, payload) VALUES (?,?,?,?,?,?,?,?)',
                                      (e['id'], CLIENT_ID, e['at'], e.get('clock'), e['actor'], e.get('batch'), e['type'], json.dumps(e['payload'])))
                if cur.rowcount: out.append({**e, 'seq': cur.lastrowid})
        return out

    def reset(self):
        with self.lock, self.db:
            self.db.execute('DELETE FROM events WHERE client = ?', (CLIENT_ID,))


store = Store(DB_PATH)


# ---------------------------------------------------------------- live updates
class Hub:
    def __init__(self):
        self.queues: set[asyncio.Queue] = set()

    def publish(self, msg: dict):
        for q in list(self.queues):
            q.put_nowait(msg)


hub = Hub()


# ---------------------------------------------------------------- API
class EventIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    type: str = Field(min_length=1, max_length=40)
    payload: dict = {}
    actor: str | None = None
    clock: str | None = None
    batch: str | None = None


class AppendIn(BaseModel):
    events: list[EventIn]
    replay: bool = False  # demo history or an imported journal: events keep their own actors


app = FastAPI(title='Miraflores workpaper journal')


def person(x_user: str | None) -> dict:
    if not x_user or x_user not in USERS:
        raise HTTPException(401, 'Unknown person. Choose someone in the role switcher.')
    return USERS[x_user]


@app.get('/api/health')
def health():
    return {'ok': True, 'client': CLIENT_ID, 'packet_sha256': PACKET_SHA, 'events': len(store.all()), 'demo': DEMO}


@app.get('/api/users')
def users():
    return list(USERS.values())


@app.get('/api/events')
def events(after: int = 0):
    return {'events': store.all(after)}


@app.post('/api/events')
def append(body: AppendIn, x_user: str | None = Header(default=None)):
    user = person(x_user)
    if body.replay and not (DEMO or user['role'] == 'firm_administrator'):
        raise HTTPException(403, 'Only the firm administrator can import a journal')
    existing = store.all()
    state = State(PACKET, existing)
    now = datetime.now(timezone.utc).isoformat()
    accepted = []
    for e in body.events:
        ev = e.model_dump()
        ev['actor'] = ev['actor'] or user['id']
        if not body.replay and ev['actor'] != user['id']:
            raise HTTPException(403, 'You can only act as yourself')
        actor = USERS.get(ev['actor'])
        if not actor:
            raise HTTPException(400, f'Unknown actor {ev["actor"]}')
        if not body.replay:
            try:
                ev = check(state, actor, ev)
            except Denied as d:
                raise HTTPException(403, str(d))
        ev['at'] = now
        state.apply(ev)  # later events in the same batch see this one (e.g. propose then approve)
        accepted.append(ev)
    stored = store.append(accepted)
    if stored:
        hub.publish({'type': 'append', 'events': stored})
    return {'events': stored}


@app.delete('/api/events')
def reset(x_user: str | None = Header(default=None)):
    user = person(x_user)
    if not (DEMO or user['role'] == 'firm_administrator'):
        raise HTTPException(403, 'Only the firm administrator can reset the journal')
    store.reset()
    hub.publish({'type': 'reset'})
    return {'ok': True}


@app.post('/api/presence')
async def presence(request: Request, x_user: str | None = Header(default=None)):
    person(x_user)
    body = await request.json()
    hub.publish({'type': 'presence', 'user': x_user, 'route': str(body.get('route', ''))[:200], 'at': body.get('at')})
    return {'ok': True}


@app.get('/api/stream')
async def stream(request: Request):
    q: asyncio.Queue = asyncio.Queue()
    hub.queues.add(q)

    async def gen():
        try:
            yield 'retry: 2000\n\n'
            while not await request.is_disconnected():
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield f'data: {json.dumps(msg)}\n\n'
                except asyncio.TimeoutError:
                    yield ': keep-alive\n\n'
        finally:
            hub.queues.discard(q)

    return StreamingResponse(gen(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache'})


# ---------------------------------------------------------------- the app itself (only the files it needs)
@app.get('/')
@app.get('/index.html')
def index():
    return FileResponse(ROOT / 'index.html')


@app.get('/styles.css')
def styles():
    return FileResponse(ROOT / 'styles.css')


@app.get('/okafor_lindqvist_2025_packet.json')
def packet():
    return FileResponse(PACKET_PATH, media_type='application/json')


app.mount('/js', StaticFiles(directory=ROOT / 'js'), name='js')
app.mount('/test', StaticFiles(directory=ROOT / 'test'), name='test')
app.mount('/docs', StaticFiles(directory=ROOT / 'docs', html=True), name='docs')
