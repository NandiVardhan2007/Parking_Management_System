# ================================================================
#  KPR TRANSPORT PARKING SYSTEM — Python Backend
#  server.py  |  Flask + SQLite (stdlib sqlite3)
#
#  Endpoints:
#    GET    /api/health
#    GET    /api/stats
#    GET    /api/settings
#    POST   /api/settings
#    GET    /api/records          ?status=IN|OUT  &q=search  &page=1  &limit=200
#    GET    /api/records/<id>
#    POST   /api/records
#    PATCH  /api/records/<id>/exit
#    DELETE /api/records/<id>
#    DELETE /api/records          (body: {"confirm":"DELETE_ALL"})
#    POST   /api/import
# ================================================================

import os
import sqlite3
import math
import datetime
from contextlib import contextmanager
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

# ── Config ───────────────────────────────────────────────────────
PORT    = int(os.environ.get("PORT", 3000))
DB_PATH = os.environ.get("DB_PATH", str(Path(__file__).parent / "kpr.db"))
PUBLIC  = Path(__file__).parent / "public"

app = Flask(__name__, static_folder=None)
CORS(app)  # Allow all origins (fine for local network use)

# ── Database ──────────────────────────────────────────────────────
def get_db() -> sqlite3.Connection:
    """Open a connection with row_factory so rows act like dicts."""
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    # Performance settings — mirrors the Node version
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA synchronous  = NORMAL")
    con.execute("PRAGMA cache_size   = -32000")   # 32 MB
    con.execute("PRAGMA foreign_keys = ON")
    return con

@contextmanager
def db_conn():
    """Context manager — commits on success, rolls back on error."""
    con = get_db()
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def init_db():
    """Create tables, indexes and seed default settings."""
    with db_conn() as con:
        con.executescript("""
            CREATE TABLE IF NOT EXISTS records (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                token         INTEGER NOT NULL UNIQUE,
                lorry         TEXT    NOT NULL COLLATE NOCASE,
                driver        TEXT    NOT NULL DEFAULT '--',
                phone         TEXT    NOT NULL DEFAULT '--',
                remarks       TEXT    NOT NULL DEFAULT '--',
                entry_iso     TEXT    NOT NULL,
                entry_display TEXT    NOT NULL,
                exit_iso      TEXT,
                exit_display  TEXT    DEFAULT '--',
                days          INTEGER,
                amount        REAL,
                status        TEXT    NOT NULL DEFAULT 'IN'
                                      CHECK(status IN ('IN','OUT')),
                created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_status ON records(status);
            CREATE INDEX IF NOT EXISTS idx_lorry  ON records(lorry);
            CREATE INDEX IF NOT EXISTS idx_token  ON records(token);
            CREATE INDEX IF NOT EXISTS idx_entry  ON records(entry_iso);
            CREATE INDEX IF NOT EXISTS idx_exit   ON records(exit_iso);

            INSERT OR IGNORE INTO settings(key, value) VALUES ('daily_rate', '120');
        """)

init_db()

# ── Helpers ───────────────────────────────────────────────────────
def row_to_dict(row) -> dict | None:
    """Convert a sqlite3.Row to a plain dict with camelCase keys."""
    if row is None:
        return None
    r = dict(row)
    return {
        "id":           r["id"],
        "token":        r["token"],
        "lorry":        r["lorry"],
        "driver":       r["driver"],
        "phone":        r["phone"],
        "remarks":      r["remarks"],
        "entryISO":     r["entry_iso"],
        "entryDisplay": r["entry_display"],
        "exitISO":      r["exit_iso"],
        "exitDisplay":  r["exit_display"] or "--",
        "days":         r["days"],
        "amount":       r["amount"],
        "status":       r["status"],
        "createdAt":    r["created_at"],
    }

def get_rate(con: sqlite3.Connection) -> float:
    row = con.execute("SELECT value FROM settings WHERE key='daily_rate'").fetchone()
    return float(row["value"]) if row else 120.0

def calc_days(entry_iso: str, exit_iso: str) -> int:
    """Ceiling of (exit - entry) in days, minimum 1."""
    entry = datetime.datetime.fromisoformat(entry_iso.replace("Z", "+00:00"))
    exit_ = datetime.datetime.fromisoformat(exit_iso.replace("Z", "+00:00"))
    diff  = (exit_ - entry).total_seconds()
    if diff <= 0:
        return 1
    return max(1, math.ceil(diff / 86400))

def now_iso() -> str:
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")

def fmt_display(iso: str) -> str:
    """Format an ISO string to a human-readable Indian locale-style string."""
    dt = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    # Convert UTC → IST (UTC+5:30)
    ist = dt + datetime.timedelta(hours=5, minutes=30)
    return ist.strftime("%-d/%-m/%Y, %-I:%M:%S %p")

def next_token(con: sqlite3.Connection) -> int:
    row = con.execute("SELECT COALESCE(MAX(token), 0) + 1 AS nxt FROM records").fetchone()
    return row["nxt"]

def ok(data=None, **kwargs):
    payload = {"ok": True}
    if data is not None:
        payload["data"] = data
    payload.update(kwargs)
    return jsonify(payload)

def err(msg: str, status: int = 400):
    return jsonify({"ok": False, "error": msg}), status

# ── Static files (serve frontend from ./public) ───────────────────
if PUBLIC.exists():
    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_static(path):
        if path and (PUBLIC / path).exists():
            return send_from_directory(str(PUBLIC), path)
        return send_from_directory(str(PUBLIC), "index.html")

# ── Routes ────────────────────────────────────────────────────────

# ▸ GET /api/health
@app.get("/api/health")
def health():
    return ok(db=DB_PATH, timestamp=now_iso())


# ▸ GET /api/stats
@app.get("/api/stats")
def stats():
    today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
    with db_conn() as con:
        row = con.execute("""
            SELECT
                SUM(CASE WHEN status='IN'  THEN 1 ELSE 0 END)                                              AS parked,
                SUM(CASE WHEN date(entry_iso)=?    THEN 1 ELSE 0 END)                                      AS today_entries,
                SUM(CASE WHEN status='OUT' AND exit_iso IS NOT NULL AND date(exit_iso)=? THEN 1 ELSE 0 END) AS today_exits,
                SUM(CASE WHEN status='OUT' AND exit_iso IS NOT NULL AND date(exit_iso)=? THEN amount ELSE 0 END) AS today_revenue,
                COUNT(*)                                                                                     AS total,
                SUM(CASE WHEN status='OUT' THEN 1 ELSE 0 END)                                              AS exited,
                SUM(CASE WHEN status='OUT' THEN amount ELSE 0 END)                                         AS total_revenue
            FROM records
        """, (today, today, today)).fetchone()
    return ok(dict(row))


# ▸ GET /api/settings
@app.get("/api/settings")
def get_settings():
    with db_conn() as con:
        rows = con.execute("SELECT key, value FROM settings").fetchall()
    return ok({r["key"]: r["value"] for r in rows})


# ▸ POST /api/settings
@app.post("/api/settings")
def post_settings():
    body = request.get_json(silent=True) or {}
    if "daily_rate" not in body:
        return err("daily_rate required")
    try:
        rate = float(body["daily_rate"])
        if rate < 1:
            raise ValueError
    except (TypeError, ValueError):
        return err("Invalid rate")
    with db_conn() as con:
        con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('daily_rate',?)", (str(rate),))
    return ok({"daily_rate": rate})


# ▸ GET /api/records
@app.get("/api/records")
def list_records():
    status = request.args.get("status", "").upper()
    q      = request.args.get("q", "").strip()
    page   = max(1, int(request.args.get("page",  1)))
    limit  = max(1, int(request.args.get("limit", 200)))
    offset = (page - 1) * limit

    where  = ["1=1"]
    params = []

    if status and status != "ALL":
        where.append("status = ?")
        params.append(status)

    if q:
        where.append("(lorry LIKE ? OR driver LIKE ? OR CAST(token AS TEXT) LIKE ?)")
        like = f"%{q}%"
        params.extend([like, like, like])

    clause = " AND ".join(where)

    with db_conn() as con:
        total = con.execute(
            f"SELECT COUNT(*) AS c FROM records WHERE {clause}", params
        ).fetchone()["c"]

        rows = con.execute(
            f"SELECT * FROM records WHERE {clause} ORDER BY token DESC LIMIT ? OFFSET ?",
            params + [limit, offset]
        ).fetchall()

    return jsonify({
        "ok":    True,
        "total": total,
        "page":  page,
        "limit": limit,
        "data":  [row_to_dict(r) for r in rows],
    })


# ▸ GET /api/records/<id>
@app.get("/api/records/<int:record_id>")
def get_record(record_id: int):
    with db_conn() as con:
        row = con.execute("SELECT * FROM records WHERE id=?", (record_id,)).fetchone()
    if not row:
        return err("Record not found", 404)
    return ok(row_to_dict(row))


# ▸ POST /api/records  — new entry
@app.post("/api/records")
def create_record():
    body = request.get_json(silent=True) or {}
    lorry = (body.get("lorry") or "").strip().upper()
    if not lorry:
        return err("lorry is required")

    with db_conn() as con:
        # Duplicate check
        dup = con.execute(
            "SELECT token FROM records WHERE lorry=? COLLATE NOCASE AND status='IN'",
            (lorry,)
        ).fetchone()
        if dup:
            return err(f"{lorry} is already parked (Token #{dup['token']})", 409)

        # Timestamps
        entry_iso = body.get("entryISO") or now_iso()
        entry_display = fmt_display(entry_iso)
        token = next_token(con)

        con.execute("""
            INSERT INTO records
                (token, lorry, driver, phone, remarks, entry_iso, entry_display, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'IN')
        """, (
            token,
            lorry,
            (body.get("driver")  or "").strip() or "--",
            (body.get("phone")   or "").strip() or "--",
            (body.get("remarks") or "").strip() or "--",
            entry_iso,
            entry_display,
        ))
        new_row = con.execute("SELECT * FROM records WHERE token=?", (token,)).fetchone()

    return ok(row_to_dict(new_row)), 201


# ▸ PATCH /api/records/<id>/exit
@app.route("/api/records/<int:record_id>/exit", methods=["PATCH"])
def process_exit(record_id: int):
    body = request.get_json(silent=True) or {}

    with db_conn() as con:
        row = con.execute("SELECT * FROM records WHERE id=?", (record_id,)).fetchone()
        if not row:
            return err("Record not found", 404)
        if row["status"] == "OUT":
            return err(f"Token #{row['token']} already exited", 409)

        rate     = float(body.get("rate") or get_rate(con))
        exit_iso = body.get("exitISO") or now_iso()
        days     = calc_days(row["entry_iso"], exit_iso)
        amount   = days * rate

        con.execute("""
            UPDATE records
            SET exit_iso=?, exit_display=?, days=?, amount=?, status='OUT'
            WHERE id=? AND status='IN'
        """, (exit_iso, fmt_display(exit_iso), days, amount, record_id))

        updated = con.execute("SELECT * FROM records WHERE id=?", (record_id,)).fetchone()

    return ok(row_to_dict(updated))


# ▸ DELETE /api/records/<id>
@app.delete("/api/records/<int:record_id>")
def delete_record(record_id: int):
    with db_conn() as con:
        row = con.execute("SELECT id FROM records WHERE id=?", (record_id,)).fetchone()
        if not row:
            return err("Record not found", 404)
        con.execute("DELETE FROM records WHERE id=?", (record_id,))
    return ok(message=f"Record {record_id} deleted")


# ▸ DELETE /api/records  — clear ALL
@app.delete("/api/records")
def delete_all_records():
    body = request.get_json(silent=True) or {}
    if body.get("confirm") != "DELETE_ALL":
        return err('Send {"confirm": "DELETE_ALL"} to confirm')
    with db_conn() as con:
        con.execute("DELETE FROM records")
    return ok(message="All records deleted")


# ▸ POST /api/import  — bulk import
@app.post("/api/import")
def bulk_import():
    body    = request.get_json(silent=True) or {}
    records = body.get("records")
    if not isinstance(records, list):
        return err("records array required")

    added  = 0
    errors = []

    with db_conn() as con:
        rate = get_rate(con)

        for i, r in enumerate(records):
            try:
                lorry = (r.get("lorry") or "").strip().upper()
                if not lorry:
                    raise ValueError("Missing lorry")

                entry_iso = r.get("entryISO") or now_iso()
                exit_iso  = r.get("exitISO")  or None
                status    = "OUT" if exit_iso else "IN"
                days      = calc_days(entry_iso, exit_iso) if exit_iso else None
                amount    = days * rate if days else None

                # Token resolution
                token = int(r["token"]) if r.get("token") else None
                if token:
                    conflict = con.execute(
                        "SELECT id FROM records WHERE token=?", (token,)
                    ).fetchone()
                    if conflict:
                        token = None  # fall through to auto-assign

                if not token:
                    token = next_token(con)

                con.execute("""
                    INSERT INTO records
                        (token, lorry, driver, phone, remarks,
                         entry_iso, entry_display,
                         exit_iso, exit_display,
                         days, amount, status)
                    VALUES (?,?,?,?,?, ?,?, ?,?, ?,?,?)
                """, (
                    token,
                    lorry,
                    (r.get("driver")  or "--").strip() or "--",
                    (r.get("phone")   or "--").strip() or "--",
                    (r.get("remarks") or "--").strip() or "--",
                    entry_iso,
                    fmt_display(entry_iso),
                    exit_iso,
                    fmt_display(exit_iso) if exit_iso else "--",
                    days,
                    amount,
                    status,
                ))
                added += 1

            except Exception as e:
                errors.append({"row": i + 1, "error": str(e)})

    resp = {
        "ok":      True,
        "added":   added,
        "message": f"Imported {added} of {len(records)} records",
    }
    if errors:
        resp["errors"] = errors
    return jsonify(resp)


# ── Run ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"✅  KPR Transport API running at http://localhost:{PORT}")
    print(f"📁  Database: {DB_PATH}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
