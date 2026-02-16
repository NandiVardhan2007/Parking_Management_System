# ================================================================
#  KPR TRANSPORT PARKING SYSTEM — Python Backend
#  server.py  |  Flask + SQLite
#
#  Endpoints (original):
#    GET    /api/health
#    GET    /api/stats
#    GET    /api/settings
#    POST   /api/settings
#    GET    /api/records
#    GET    /api/records/<id>
#    POST   /api/records
#    PATCH  /api/records/<id>/exit
#    DELETE /api/records/<id>
#    DELETE /api/records
#    POST   /api/import
#
#  NEW — Print Queue endpoints:
#    POST   /api/print-queue          ← website adds a print job
#    GET    /api/print-queue/pending  ← laptop polls for new jobs
#    PATCH  /api/print-queue/<id>/ack ← laptop marks job as done
#    GET    /api/print-queue          ← view all jobs (admin)
#    DELETE /api/print-queue/<id>     ← delete a job
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
CORS(app)

# ── Database ──────────────────────────────────────────────────────
def get_db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA synchronous  = NORMAL")
    con.execute("PRAGMA cache_size   = -32000")
    con.execute("PRAGMA foreign_keys = ON")
    return con

@contextmanager
def db_conn():
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

            CREATE TABLE IF NOT EXISTS print_queue (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                job_data    TEXT    NOT NULL,
                status      TEXT    NOT NULL DEFAULT 'pending'
                                    CHECK(status IN ('pending','done','failed')),
                created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                ack_at      TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_status    ON records(status);
            CREATE INDEX IF NOT EXISTS idx_lorry     ON records(lorry);
            CREATE INDEX IF NOT EXISTS idx_token     ON records(token);
            CREATE INDEX IF NOT EXISTS idx_entry     ON records(entry_iso);
            CREATE INDEX IF NOT EXISTS idx_exit      ON records(exit_iso);
            CREATE INDEX IF NOT EXISTS idx_pq_status ON print_queue(status);

            INSERT OR IGNORE INTO settings(key, value) VALUES ('daily_rate', '120');
        """)

init_db()

# ── Helpers ───────────────────────────────────────────────────────
def row_to_dict(row) -> dict | None:
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
    entry = datetime.datetime.fromisoformat(entry_iso.replace("Z", "+00:00"))
    exit_ = datetime.datetime.fromisoformat(exit_iso.replace("Z", "+00:00"))
    diff  = (exit_ - entry).total_seconds()
    if diff <= 0:
        return 1
    return max(1, math.ceil(diff / 86400))

def now_iso() -> str:
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")

def fmt_display(iso: str) -> str:
    dt  = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
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

# ── Static files ──────────────────────────────────────────────────
if PUBLIC.exists():
    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_static(path):
        if path and (PUBLIC / path).exists():
            return send_from_directory(str(PUBLIC), path)
        return send_from_directory(str(PUBLIC), "index.html")

# ── Original Routes ───────────────────────────────────────────────

@app.get("/api/health")
def health():
    return ok(db=DB_PATH, timestamp=now_iso())


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


@app.get("/api/settings")
def get_settings():
    with db_conn() as con:
        rows = con.execute("SELECT key, value FROM settings").fetchall()
    return ok({r["key"]: r["value"] for r in rows})


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


@app.get("/api/records/<int:record_id>")
def get_record(record_id: int):
    with db_conn() as con:
        row = con.execute("SELECT * FROM records WHERE id=?", (record_id,)).fetchone()
    if not row:
        return err("Record not found", 404)
    return ok(row_to_dict(row))


@app.post("/api/records")
def create_record():
    body  = request.get_json(silent=True) or {}
    lorry = (body.get("lorry") or "").strip().upper()
    if not lorry:
        return err("lorry is required")

    with db_conn() as con:
        dup = con.execute(
            "SELECT token FROM records WHERE lorry=? COLLATE NOCASE AND status='IN'",
            (lorry,)
        ).fetchone()
        if dup:
            return err(f"{lorry} is already parked (Token #{dup['token']})", 409)

        entry_iso     = body.get("entryISO") or now_iso()
        entry_display = fmt_display(entry_iso)
        token         = next_token(con)

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


@app.delete("/api/records/<int:record_id>")
def delete_record(record_id: int):
    with db_conn() as con:
        row = con.execute("SELECT id FROM records WHERE id=?", (record_id,)).fetchone()
        if not row:
            return err("Record not found", 404)
        con.execute("DELETE FROM records WHERE id=?", (record_id,))
    return ok(message=f"Record {record_id} deleted")


@app.delete("/api/records")
def delete_all_records():
    body = request.get_json(silent=True) or {}
    if body.get("confirm") != "DELETE_ALL":
        return err('Send {"confirm": "DELETE_ALL"} to confirm')
    with db_conn() as con:
        con.execute("DELETE FROM records")
    return ok(message="All records deleted")


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

                token = int(r["token"]) if r.get("token") else None
                if token:
                    conflict = con.execute(
                        "SELECT id FROM records WHERE token=?", (token,)
                    ).fetchone()
                    if conflict:
                        token = None

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


# ================================================================
#  PRINT QUEUE — New endpoints
# ================================================================
#
#  How it works:
#  1. Website clicks Print → POST /api/print-queue  (saves job to DB)
#  2. Parking laptop runs print_server.py which polls every 3 seconds:
#       GET /api/print-queue/pending  → gets new jobs
#  3. Laptop prints receipt silently
#  4. Laptop confirms:
#       PATCH /api/print-queue/<id>/ack  → marks job done
#
#  No tunnels. No port forwarding. Works from anywhere.
# ================================================================

@app.post("/api/print-queue")
def enqueue_print():
    """
    Website calls this when user clicks Print.
    Saves the receipt data into the queue.
    """
    # Optional secret check (uses same secret as config.ini SECRET_TOKEN)
    secret = os.environ.get("PRINT_SECRET", "KPR2024SECRET")
    if request.headers.get("X-Print-Token", "") != secret:
        return err("Unauthorized", 401)

    data = request.get_json(silent=True)
    if not data:
        return err("No JSON body")

    import json
    with db_conn() as con:
        con.execute(
            "INSERT INTO print_queue (job_data, status) VALUES (?, 'pending')",
            (json.dumps(data),)
        )
        job_id = con.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]

    return ok({"job_id": job_id, "message": "Print job queued"})


@app.get("/api/print-queue/pending")
def get_pending_jobs():
    """
    Parking laptop polls this every 3 seconds.
    Returns all unprinted jobs.
    """
    secret = os.environ.get("PRINT_SECRET", "KPR2024SECRET")
    if request.headers.get("X-Print-Token", "") != secret:
        return err("Unauthorized", 401)

    import json
    with db_conn() as con:
        rows = con.execute(
            "SELECT id, job_data, created_at FROM print_queue WHERE status='pending' ORDER BY id ASC"
        ).fetchall()

    jobs = []
    for row in rows:
        try:
            jobs.append({
                "id":         row["id"],
                "data":       json.loads(row["job_data"]),
                "created_at": row["created_at"]
            })
        except Exception:
            pass

    return ok(jobs)


@app.route("/api/print-queue/<int:job_id>/ack", methods=["PATCH"])
def ack_print_job(job_id: int):
    """
    Parking laptop calls this after successfully printing.
    Marks the job as done so it won't be printed again.
    """
    secret = os.environ.get("PRINT_SECRET", "KPR2024SECRET")
    if request.headers.get("X-Print-Token", "") != secret:
        return err("Unauthorized", 401)

    body   = request.get_json(silent=True) or {}
    status = "done" if body.get("success", True) else "failed"

    with db_conn() as con:
        row = con.execute("SELECT id FROM print_queue WHERE id=?", (job_id,)).fetchone()
        if not row:
            return err("Job not found", 404)
        con.execute(
            "UPDATE print_queue SET status=?, ack_at=datetime('now') WHERE id=?",
            (status, job_id)
        )

    return ok({"job_id": job_id, "status": status})


@app.get("/api/print-queue")
def list_print_queue():
    """View all print jobs (last 100)."""
    secret = os.environ.get("PRINT_SECRET", "KPR2024SECRET")
    if request.headers.get("X-Print-Token", "") != secret:
        return err("Unauthorized", 401)

    import json
    with db_conn() as con:
        rows = con.execute(
            "SELECT id, status, created_at, ack_at, job_data FROM print_queue ORDER BY id DESC LIMIT 100"
        ).fetchall()

    jobs = []
    for row in rows:
        try:
            d = json.loads(row["job_data"])
            jobs.append({
                "id":         row["id"],
                "status":     row["status"],
                "created_at": row["created_at"],
                "ack_at":     row["ack_at"],
                "token":      d.get("token"),
                "lorry":      d.get("lorry"),
                "type":       d.get("type"),
            })
        except Exception:
            pass

    return ok(jobs)


@app.delete("/api/print-queue/<int:job_id>")
def delete_print_job(job_id: int):
    """Delete a specific print job."""
    secret = os.environ.get("PRINT_SECRET", "KPR2024SECRET")
    if request.headers.get("X-Print-Token", "") != secret:
        return err("Unauthorized", 401)

    with db_conn() as con:
        con.execute("DELETE FROM print_queue WHERE id=?", (job_id,))
    return ok(message=f"Job {job_id} deleted")


@app.delete("/api/print-queue")
def clear_old_print_jobs():
    """
    Auto-cleanup: delete done/failed jobs older than 7 days.
    Called automatically by the laptop poller.
    """
    secret = os.environ.get("PRINT_SECRET", "KPR2024SECRET")
    if request.headers.get("X-Print-Token", "") != secret:
        return err("Unauthorized", 401)

    with db_conn() as con:
        con.execute(
            "DELETE FROM print_queue WHERE status != 'pending' AND created_at < datetime('now', '-7 days')"
        )
    return ok(message="Old jobs cleaned up")


# ── Run ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"KPR Transport API running at http://localhost:{PORT}")
    print(f"Database: {DB_PATH}")
    print(f"Print Queue: enabled at /api/print-queue")
    app.run(host="0.0.0.0", port=PORT, debug=False)