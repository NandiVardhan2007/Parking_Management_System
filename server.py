# ================================================================
#  KPR TRANSPORT PARKING SYSTEM — Python Backend
#  server.py  |  Flask + SQLite
#
#  IMPROVED VERSION:
#  - Date-only billing (no time component)
#  - Entry 14th Feb, Exit 18th Feb = 4 days (not 5)
#  - Enhanced error handling
# ================================================================

import os
import sqlite3
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
                entry_date    TEXT    NOT NULL,
                entry_display TEXT    NOT NULL,
                exit_date     TEXT,
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
            CREATE INDEX IF NOT EXISTS idx_entry     ON records(entry_date);
            CREATE INDEX IF NOT EXISTS idx_exit      ON records(exit_date);
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
        "entryDate":    r["entry_date"],
        "entryDisplay": r["entry_display"],
        "exitDate":     r["exit_date"],
        "exitDisplay":  r["exit_display"] or "--",
        "days":         r["days"],
        "amount":       r["amount"],
        "status":       r["status"],
        "createdAt":    r["created_at"],
    }

def get_rate(con: sqlite3.Connection) -> float:
    row = con.execute("SELECT value FROM settings WHERE key='daily_rate'").fetchone()
    return float(row["value"]) if row else 120.0

def calc_days(entry_date: str, exit_date: str) -> int:
    """
    Calculate parking days using DATE ONLY (not time).
    Entry: 2025-02-14, Exit: 2025-02-18 → 4 days
    Formula: exit_date - entry_date
    """
    try:
        # Parse dates (format: YYYY-MM-DD)
        entry = datetime.datetime.strptime(entry_date[:10], "%Y-%m-%d").date()
        exit_ = datetime.datetime.strptime(exit_date[:10], "%Y-%m-%d").date()
        
        # Calculate difference in days
        diff_days = (exit_ - entry).days
        
        # Minimum 1 day (same day entry/exit = 1 day)
        return max(1, diff_days) if diff_days > 0 else 1
    except Exception:
        return 1

def today_date() -> str:
    """Return today's date in YYYY-MM-DD format"""
    return datetime.date.today().strftime("%Y-%m-%d")

def fmt_display(date_str: str) -> str:
    """Format date for display: DD/MM/YYYY"""
    try:
        dt = datetime.datetime.strptime(date_str[:10], "%Y-%m-%d")
        return dt.strftime("%d/%m/%Y")
    except Exception:
        return date_str

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

# ── Routes ───────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return ok(db=DB_PATH, timestamp=datetime.datetime.utcnow().isoformat())


@app.get("/api/stats")
def stats():
    today = today_date()
    with db_conn() as con:
        row = con.execute("""
            SELECT
                SUM(CASE WHEN status='IN'  THEN 1 ELSE 0 END)                                AS parked,
                SUM(CASE WHEN entry_date=? THEN 1 ELSE 0 END)                                AS today_entries,
                SUM(CASE WHEN status='OUT' AND exit_date=? THEN 1 ELSE 0 END)                AS today_exits,
                SUM(CASE WHEN status='OUT' AND exit_date=? THEN amount ELSE 0 END)           AS today_revenue,
                COUNT(*)                                                                      AS total,
                SUM(CASE WHEN status='OUT' THEN 1 ELSE 0 END)                                AS exited,
                SUM(CASE WHEN status='OUT' THEN amount ELSE 0 END)                           AS total_revenue
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
def get_records():
    q      = request.args.get("q", "").strip()
    status = request.args.get("status", "").strip().upper()
    page   = int(request.args.get("page",  "1"))
    limit  = int(request.args.get("limit", "200"))
    offset = (page - 1) * limit

    with db_conn() as con:
        sql = "SELECT * FROM records WHERE 1=1"
        params = []

        if status in ("IN", "OUT"):
            sql += " AND status = ?"
            params.append(status)
        if q:
            sql += " AND (lorry LIKE ? OR driver LIKE ? OR CAST(token AS TEXT) LIKE ?)"
            qp = f"%{q}%"
            params.extend([qp, qp, qp])

        sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        rows = con.execute(sql, params).fetchall()

    return ok([row_to_dict(r) for r in rows])


@app.get("/api/records/<int:rec_id>")
def get_record(rec_id: int):
    with db_conn() as con:
        row = con.execute("SELECT * FROM records WHERE id=?", (rec_id,)).fetchone()
    if not row:
        return err("Record not found", 404)
    return ok(row_to_dict(row))


@app.post("/api/records")
def create_record():
    body = request.get_json(silent=True) or {}
    lorry = (body.get("lorry") or "").strip().upper()
    if not lorry:
        return err("Lorry number required")

    entry_date = body.get("entryDate") or today_date()
    
    with db_conn() as con:
        # Check for duplicate parked vehicle
        dup = con.execute(
            "SELECT token FROM records WHERE lorry=? AND status='IN'", (lorry,)
        ).fetchone()
        if dup:
            return err(f"{lorry} is already parked with token #{dup['token']}", 409)

        token = next_token(con)
        con.execute("""
            INSERT INTO records
                (token, lorry, driver, phone, remarks, entry_date, entry_display, status)
            VALUES (?,?,?,?,?, ?,?, 'IN')
        """, (
            token,
            lorry,
            (body.get("driver")  or "--").strip() or "--",
            (body.get("phone")   or "--").strip() or "--",
            (body.get("remarks") or "--").strip() or "--",
            entry_date,
            fmt_display(entry_date)
        ))
        row = con.execute("SELECT * FROM records WHERE token=?", (token,)).fetchone()

    return ok(row_to_dict(row), message=f"Entry recorded: Token #{token}")


@app.patch("/api/records/<int:rec_id>/exit")
def exit_record(rec_id: int):
    body = request.get_json(silent=True) or {}
    exit_date = body.get("exitDate") or today_date()

    with db_conn() as con:
        row = con.execute("SELECT * FROM records WHERE id=?", (rec_id,)).fetchone()
        if not row:
            return err("Record not found", 404)
        if row["status"] == "OUT":
            return err("Vehicle already exited", 400)

        entry_date = row["entry_date"]
        days = calc_days(entry_date, exit_date)
        rate = get_rate(con)
        amount = days * rate

        con.execute("""
            UPDATE records
            SET exit_date=?, exit_display=?, days=?, amount=?, status='OUT'
            WHERE id=?
        """, (exit_date, fmt_display(exit_date), days, amount, rec_id))

        updated = con.execute("SELECT * FROM records WHERE id=?", (rec_id,)).fetchone()

    return ok(row_to_dict(updated), message=f"Exit processed: {days} days, Rs.{amount}")


@app.delete("/api/records/<int:rec_id>")
def delete_record(rec_id: int):
    with db_conn() as con:
        row = con.execute("SELECT id FROM records WHERE id=?", (rec_id,)).fetchone()
        if not row:
            return err("Record not found", 404)
        con.execute("DELETE FROM records WHERE id=?", (rec_id,))
    return ok(message=f"Record {rec_id} deleted")


@app.delete("/api/records")
def delete_all_records():
    body = request.get_json(silent=True) or {}
    if body.get("confirm") != "DELETE_ALL":
        return err("Confirmation required")
    with db_conn() as con:
        con.execute("DELETE FROM records")
    return ok(message="All records deleted")


@app.post("/api/import")
def import_records():
    body = request.get_json(silent=True) or {}
    records = body.get("records", [])
    if not records:
        return err("No records provided")

    added  = 0
    errors = []

    with db_conn() as con:
        rate = get_rate(con)

        for i, r in enumerate(records):
            try:
                lorry = (r.get("lorry") or "").strip().upper()
                if not lorry:
                    raise ValueError("Missing lorry")

                entry_date = r.get("entryDate") or today_date()
                exit_date  = r.get("exitDate")  or None
                status     = "OUT" if exit_date else "IN"
                days       = calc_days(entry_date, exit_date) if exit_date else None
                amount     = days * rate if days else None

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
                         entry_date, entry_display,
                         exit_date, exit_display,
                         days, amount, status)
                    VALUES (?,?,?,?,?, ?,?, ?,?, ?,?,?)
                """, (
                    token,
                    lorry,
                    (r.get("driver")  or "--").strip() or "--",
                    (r.get("phone")   or "--").strip() or "--",
                    (r.get("remarks") or "--").strip() or "--",
                    entry_date,
                    fmt_display(entry_date),
                    exit_date,
                    fmt_display(exit_date) if exit_date else "--",
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
#  PRINT QUEUE — Print endpoints
# ================================================================

@app.post("/api/print-queue")
def enqueue_print():
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
    secret = os.environ.get("PRINT_SECRET", "KPR2024SECRET")
    if request.headers.get("X-Print-Token", "") != secret:
        return err("Unauthorized", 401)

    with db_conn() as con:
        con.execute("DELETE FROM print_queue WHERE id=?", (job_id,))
    return ok(message=f"Job {job_id} deleted")


@app.delete("/api/print-queue")
def clear_old_print_jobs():
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
    print(f"🚛 KPR Transport API running at http://localhost:{PORT}")
    print(f"📁 Database: {DB_PATH}")
    print(f"📅 Billing: DATE-ONLY calculation (14th-18th = 4 days)")
    print(f"🖨️  Print Queue: enabled")
    app.run(host="0.0.0.0", port=PORT, debug=False)