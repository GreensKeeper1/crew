#!/usr/bin/env python3
"""Crew Films show server: the gallery, the films and comments, with no Internet.

Run it on the rig box (or any computer on the home LAN), then open
http://<that-computer>:8080/movies.html on the projector's browser and on
phones on the same Wi-Fi. Python 3.8+ standard library only; nothing to install.

    python3 server/crew_server.py init          # once: makes server/crew.conf.json
    python3 server/crew_server.py fetch-media   # while online: copies the films into media/
    python3 server/crew_server.py serve         # the show (default port 8080)

What it does
  * Serves the site from the repo folder. Films found in media/ are served
    from this computer (with seeking), so nothing streams from the Internet.
  * Speaks the same comment API as the online service (server/apps_script/Code.gs),
    so comments.js works the same on the LAN and on GitHub Pages.
  * Keeps sign-ups and comments in server/data/crew.db. When "online_api" and
    "sync_key" are set in crew.conf.json and the Internet is back, it sends new
    sign-ups and comments up (the online service then emails the owner about
    each new sign-up) and pulls down comments made online.

Security notes
  * A 6-digit code is a light lock (one million choices). It is never stored as
    typed: each is salted and HMAC-SHA256'd with a secret "pepper" kept in
    crew.conf.json (never in git). After 5 wrong codes an email is locked for
    15 minutes, and an address on the LAN that keeps failing is slowed down.
  * The cookie holds a random 64-hex token, not the code. Only its hash is stored.
"""
import argparse
import hashlib
import hmac
import http.server
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # the repo / site folder
CONF = os.path.join(HERE, "crew.conf.json")
DATA = os.path.join(HERE, "data")
MEDIA = os.path.join(ROOT, "media")
RELEASE_RE = re.compile(r"https://github\.com/[Gg]reens[Kk]eeper1/crew/releases/download/[A-Za-z0-9._-]+/([A-Za-z0-9._-]+\.mp4)")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s]{2,}$")
ITEM_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,99}$")
TAGS = ('<link rel="stylesheet" href="comments/comments.css">'
        '<script src="comments/config.js"></script><script src="comments/comments.js" defer></script>')

MAX_TRIES = 5            # wrong codes per email before a lock
LOCK_SECS = 15 * 60
IP_FAILS_PER_HOUR = 30   # wrong codes from one LAN address per hour
SESSION_SECS = 365 * 24 * 3600


def iso(t=None):
    d = datetime.fromtimestamp(time.time() if t is None else t, timezone.utc)
    return d.isoformat(timespec="milliseconds").replace("+00:00", "Z")


now_iso = iso


def load_conf():
    if not os.path.exists(CONF):
        sys.exit("No server/crew.conf.json yet. Run: python3 server/crew_server.py init")
    with open(CONF, encoding="utf-8") as f:
        c = json.load(f)
    if len(c.get("pepper", "")) < 32:
        sys.exit("crew.conf.json needs a 'pepper' of at least 32 characters.")
    return c


# ---------------------------------------------------------------- database
class Store:
    def __init__(self, path, pepper):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self.pepper = pepper.encode()
        self.db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users(email TEXT PRIMARY KEY, name TEXT, salt TEXT, hash TEXT,
            created_at TEXT, origin TEXT, synced INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, email TEXT, expires REAL);
        CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, item TEXT, email TEXT, name TEXT,
            text TEXT, at TEXT, synced INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0);
        CREATE INDEX IF NOT EXISTS comments_item ON comments(item, at);
        CREATE TABLE IF NOT EXISTS fails(k TEXT PRIMARY KEY, n INTEGER, since REAL, locked_until REAL);
        CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
        """)

    def q(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def code_hash(self, salt, code):
        return hmac.new(self.pepper, f"{salt}:{code}".encode(), hashlib.sha256).hexdigest()

    # --- lockouts
    def locked(self, key):
        r = self.q("SELECT locked_until FROM fails WHERE k=?", (key,))
        return bool(r) and (r[0]["locked_until"] or 0) > time.time()

    def fail(self, key, limit, window, lock):
        t = time.time()
        r = self.q("SELECT n, since FROM fails WHERE k=?", (key,))
        n, since = (r[0]["n"], r[0]["since"]) if r and t - r[0]["since"] < window else (0, t)
        n += 1
        self.q("INSERT OR REPLACE INTO fails(k,n,since,locked_until) VALUES(?,?,?,?)",
               (key, n, since, t + lock if n >= limit else 0))

    def clear(self, key):
        self.q("DELETE FROM fails WHERE k=?", (key,))

    # --- sessions
    def new_session(self, email):
        tok = secrets.token_hex(32)
        self.q("INSERT INTO sessions VALUES(?,?,?)",
               (hashlib.sha256(tok.encode()).hexdigest(), email, time.time() + SESSION_SECS))
        return tok

    def session_user(self, tok):
        if not isinstance(tok, str) or not re.fullmatch(r"[a-f0-9]{64}", tok):
            return None
        r = self.q("SELECT u.email, u.name FROM sessions s JOIN users u ON u.email=s.email "
                   "WHERE s.token_hash=? AND s.expires>?", (hashlib.sha256(tok.encode()).hexdigest(), time.time()))
        return dict(r[0]) if r else None


# ---------------------------------------------------------------- the API
class ApiError(Exception):
    pass


def clean_email(v):
    v = (v or "").strip().lower() if isinstance(v, str) else ""
    if len(v) > 254 or not EMAIL_RE.match(v):
        raise ApiError("Please enter a valid email address.")
    return v


def clean_code(v):
    if not isinstance(v, str) or not re.fullmatch(r"\d{6}", v):
        raise ApiError("The code is exactly 6 digits.")
    return v


def clean_name(v, email):
    v = re.sub(r"\s+", " ", v if isinstance(v, str) else "").strip()[:40]
    return v or email.split("@")[0][:20]


def handle(store, conf, body, ip):
    op = body.get("op")
    syncing = bool(conf.get("online_api"))
    if op == "counts":
        rows = store.q("SELECT item, COUNT(*) n FROM comments WHERE hidden=0 GROUP BY item")
        return {"counts": {r["item"]: r["n"] for r in rows}}
    if op == "comments":
        item = body.get("item")
        if not isinstance(item, str) or not ITEM_RE.match(item):
            raise ApiError("Unknown item.")
        rows = store.q("SELECT name, text, at, synced FROM comments WHERE item=? AND hidden=0 ORDER BY at", (item,))
        return {"comments": [{"name": r["name"], "text": r["text"], "at": r["at"],
                              "pending": syncing and not r["synced"]} for r in rows]}
    if op in ("register", "login"):
        ipkey = "ip:" + ip
        if store.locked(ipkey):
            raise ApiError("Too many wrong codes from this device. Try again in a little while.")
        email = clean_email(body.get("email"))
        code = clean_code(body.get("code"))
        ekey = "email:" + email
        if store.locked(ekey):
            raise ApiError("Too many wrong codes for this email. Try again in 15 minutes.")
        r = store.q("SELECT * FROM users WHERE email=?", (email,))
        if not r:
            if op == "login":
                raise ApiError("No sign-up for that email yet. Choose Sign up instead.")
            salt = secrets.token_hex(16)
            name = clean_name(body.get("name"), email)
            store.q("INSERT INTO users(email,name,salt,hash,created_at,origin,synced) VALUES(?,?,?,?,?,?,0)",
                    (email, name, salt, store.code_hash(salt, code), now_iso(), "lan"))
            print(f"[signup] new viewer on the LAN: {name}", flush=True)
            return {"token": store.new_session(email), "name": name, "new": True}
        u = r[0]
        if not hmac.compare_digest(u["hash"], store.code_hash(u["salt"], code)):
            store.fail(ekey, MAX_TRIES, LOCK_SECS, LOCK_SECS)
            store.fail(ipkey, IP_FAILS_PER_HOUR, 3600, 3600)
            raise ApiError("That email is signed up with a different code." if op == "register"
                           else "Wrong code for that email.")
        store.clear(ekey)
        return {"token": store.new_session(email), "name": u["name"]}
    if op == "me":
        u = store.session_user(body.get("token"))
        if not u:
            raise ApiError("Please sign in again.")
        return {"name": u["name"]}
    if op == "logout":
        tok = body.get("token")
        if isinstance(tok, str):
            store.q("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(tok.encode()).hexdigest(),))
        return {}
    if op == "post":
        u = store.session_user(body.get("token"))
        if not u:
            raise ApiError("Please sign in again to comment.")
        item, text = body.get("item"), body.get("text")
        if not isinstance(item, str) or not ITEM_RE.match(item):
            raise ApiError("Unknown item.")
        text = (text if isinstance(text, str) else "").strip()[:1000]
        if not text:
            raise ApiError("Write something first.")
        recent = store.q("SELECT COUNT(*) n FROM comments WHERE email=? AND at>?",
                         (u["email"], iso(time.time() - 60)))
        if recent[0]["n"] >= 5:
            raise ApiError("Slow down a little: 5 comments a minute at most.")
        c = {"id": uuid.uuid4().hex, "item": item, "name": u["name"], "text": text, "at": now_iso()}
        store.q("INSERT INTO comments(id,item,email,name,text,at,synced) VALUES(?,?,?,?,?,?,0)",
                (c["id"], item, u["email"], u["name"], text, c["at"]))
        return {"comment": c}
    raise ApiError("Unknown request.")


# ---------------------------------------------------------------- syncing with the online service
def sync_once(store, conf):
    users = [dict(r) for r in store.q(
        "SELECT email,name,salt,hash,created_at FROM users WHERE synced=0 AND origin='lan'")]
    comments = [dict(r) for r in store.q(
        "SELECT id,item,email,name,text,at FROM comments WHERE synced=0")]
    cur = store.q("SELECT v FROM meta WHERE k='cursor'")
    body = json.dumps({"op": "sync", "key": conf["sync_key"], "users": users,
                       "comments": comments, "since": cur[0]["v"] if cur else ""}).encode()
    req = urllib.request.Request(conf["online_api"], data=body,
                                 headers={"Content-Type": "text/plain;charset=utf-8"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        j = json.load(resp)
    if not j.get("ok"):
        raise RuntimeError(j.get("error", "sync refused"))
    for u in users:
        store.q("UPDATE users SET synced=1 WHERE email=?", (u["email"],))
    for c in comments:
        store.q("UPDATE comments SET synced=1 WHERE id=?", (c["id"],))
    for u in j.get("users", []):           # people who signed up online can sign in at the show
        store.q("INSERT OR IGNORE INTO users(email,name,salt,hash,created_at,origin,synced) "
                "VALUES(?,?,?,?,?,'online',1)", (u["email"], u["name"], u["salt"], u["hash"], u["created_at"]))
    for c in j.get("comments", []):
        if ITEM_RE.match(str(c.get("item", ""))):
            store.q("INSERT OR IGNORE INTO comments(id,item,email,name,text,at,synced,hidden) VALUES(?,?,?,?,?,?,1,?)",
                    (c["id"], c["item"], c.get("email", ""), c["name"], c["text"], c["at"], 1 if c.get("hidden") else 0))
            store.q("UPDATE comments SET hidden=? WHERE id=?", (1 if c.get("hidden") else 0, c["id"]))
    if j.get("cursor"):
        store.q("INSERT OR REPLACE INTO meta VALUES('cursor',?)", (j["cursor"],))
    return len(users), len(comments), len(j.get("comments", []))


def sync_loop(store, conf, every=60):
    while True:
        try:
            up_u, up_c, down = sync_once(store, conf)
            if up_u or up_c or down:
                print(f"[sync] sent {up_u} sign-ups and {up_c} comments, got {down} comments", flush=True)
        except Exception as e:   # offline is normal at a show; just try again later
            print(f"[sync] not now ({e.__class__.__name__}); will retry", flush=True)
        time.sleep(every)


# ---------------------------------------------------------------- HTTP
def make_handler(store, conf):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=ROOT, **k)

        def log_message(self, fmt, *args):
            if conf.get("verbose"):
                super().log_message(fmt, *args)

        def send_json(self, obj, status=200):
            data = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path.split("?")[0] not in ("/api", "/api/"):
                return self.send_json({"ok": False, "error": "Not found"}, 404)
            n = int(self.headers.get("Content-Length") or 0)
            if n > 16384:
                return self.send_json({"ok": False, "error": "Too big."}, 413)
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
                if not isinstance(body, dict):
                    raise ApiError("Bad request.")
                out = handle(store, conf, body, self.client_address[0])
                out["ok"] = True
                self.send_json(out)
            except ApiError as e:
                self.send_json({"ok": False, "error": str(e)})
            except (ValueError, json.JSONDecodeError):
                self.send_json({"ok": False, "error": "Bad request."}, 400)

        def do_GET(self):
            path = urllib.parse.unquote(self.path.split("?")[0])
            if path == "/api/health":
                return self.send_json({"ok": True, "crew": True, "online_sync": bool(conf.get("online_api"))})
            if path in ("/", "/movies.html"):
                return self.send_page("movies.html")
            if self.private():
                return self.send_error(404)   # never serve the config, database or git folder
            if path.startswith("/media/"):
                return self.send_media(os.path.basename(path))
            return super().do_GET()

        def private(self):
            real = os.path.realpath(self.translate_path(self.path))
            return any(real == d or real.startswith(d + os.sep)
                       for d in (os.path.realpath(HERE), os.path.realpath(os.path.join(ROOT, ".git"))))

        def send_page(self, name):
            with open(os.path.join(ROOT, name), encoding="utf-8") as f:
                html = f.read()

            def local(m):
                fn = m.group(1)
                return f"media/{fn}" if os.path.exists(os.path.join(MEDIA, fn)) else m.group(0)
            html = RELEASE_RE.sub(local, html)
            if "comments/comments.js" not in html:   # a regenerated page lost the tags: put them back
                html = html.replace("</body>", TAGS + "</body>", 1)
            data = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def send_media(self, fn):
            p = os.path.join(MEDIA, fn)
            if not re.fullmatch(r"[A-Za-z0-9._-]+", fn) or not os.path.isfile(p):
                return self.send_error(404)
            size = os.path.getsize(p)
            start, end = 0, size - 1
            rng = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "") or "")
            if rng and (rng.group(1) or rng.group(2)):
                if rng.group(1):
                    start = int(rng.group(1))
                    end = min(int(rng.group(2)), size - 1) if rng.group(2) else size - 1
                else:
                    start = max(0, size - int(rng.group(2)))
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            else:
                self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(fn)[0] or "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()
            if self.command == "HEAD":
                return
            with open(p, "rb") as f:
                f.seek(start)
                left = end - start + 1
                try:
                    while left > 0:
                        chunk = f.read(min(1 << 20, left))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        left -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass   # the player seeked or closed; normal

        def do_HEAD(self):
            path = urllib.parse.unquote(self.path.split("?")[0])
            if path.startswith("/media/"):
                return self.send_media(os.path.basename(path))
            if self.private():
                return self.send_error(404)
            return super().do_HEAD()

    return H


# ---------------------------------------------------------------- commands
def cmd_init(_):
    if os.path.exists(CONF):
        sys.exit("server/crew.conf.json already exists; not overwriting it.")
    conf = {"port": 8080, "pepper": secrets.token_hex(32), "online_api": "", "sync_key": ""}
    with open(CONF, "w", encoding="utf-8") as f:
        json.dump(conf, f, indent=2)
    os.chmod(CONF, 0o600)
    print("Wrote server/crew.conf.json.\n"
          "If you set up the online service, put this same pepper in its Script Properties as PEPPER,\n"
          "so codes chosen at a show also work online and the other way round.")


def cmd_fetch_media(_):
    with open(os.path.join(ROOT, "movies.html"), encoding="utf-8") as f:
        urls = sorted(set(m.group(0) for m in RELEASE_RE.finditer(f.read())))
    os.makedirs(MEDIA, exist_ok=True)
    for u in urls:
        fn = RELEASE_RE.match(u).group(1)
        dest = os.path.join(MEDIA, fn)
        if os.path.exists(dest):
            print("have   ", fn)
            continue
        print("getting", fn, flush=True)
        tmp = dest + ".part"
        urllib.request.urlretrieve(u, tmp)
        os.replace(tmp, dest)
    print(f"{len(urls)} films referenced; media/ is ready for an offline show.")


def cmd_serve(a):
    conf = load_conf()
    store = Store(os.path.join(DATA, "crew.db"), conf["pepper"])
    if conf.get("online_api") and conf.get("sync_key"):
        threading.Thread(target=sync_loop, args=(store, conf), daemon=True).start()
    port = a.port or conf.get("port", 8080)
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", port), make_handler(store, conf))
    print(f"Crew Films show server on port {port}. Open http://<this-computer>:{port}/movies.html", flush=True)
    srv.serve_forever()


def cmd_hide(a):
    """Hide a comment someone shouldn't have posted (it syncs as hidden only if hidden online too)."""
    conf = load_conf()
    store = Store(os.path.join(DATA, "crew.db"), conf["pepper"])
    if a.list:
        for r in store.q("SELECT id,item,name,text,at,hidden FROM comments ORDER BY at DESC LIMIT 50"):
            print(r["id"], r["item"], r["at"], ("[hidden] " if r["hidden"] else "") + r["name"] + ":", r["text"][:60])
        return
    store.q("UPDATE comments SET hidden=1 WHERE id=?", (a.id,))
    print("hidden", a.id)


def main():
    p = argparse.ArgumentParser(description="Crew Films show server")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("init").set_defaults(fn=cmd_init)
    sub.add_parser("fetch-media").set_defaults(fn=cmd_fetch_media)
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int)
    s.set_defaults(fn=cmd_serve)
    h = sub.add_parser("hide")
    h.add_argument("id", nargs="?")
    h.add_argument("--list", action="store_true")
    h.set_defaults(fn=cmd_hide)
    a = p.parse_args()
    if not getattr(a, "fn", None):
        a.port = None
        return cmd_serve(a)
    a.fn(a)


if __name__ == "__main__":
    main()
