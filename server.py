# ================================================================
#  KPR TRANSPORT PARKING SYSTEM — Python Backend
#  server.py  |  Flask + MongoDB Atlas
#
#  BILLING MODEL: DAY-WISE
#  - entry_date / exit_date compared for calendar day difference
#  - billable_days = (exit_date − entry_date).days  (minimum 1)
#  - amount        = billable_days × daily_rate
#
#  SECURITY NOTES (fixes applied):
#  - All secrets loaded from environment variables only (no hardcoding)
#  - Admin panel and /api/admin/* routes removed entirely
#  - Regex search input sanitized (re.escape) to prevent ReDoS
#  - Pagination limit capped at MAX_PAGE_LIMIT
#  - Input field lengths validated (lorry, driver, phone, remarks)
#  - CORS restricted to ALLOWED_ORIGINS env var
#  - PRINT_SECRET no longer has an insecure default
# ================================================================

import os
import re
import datetime
import threading
from pathlib import Path

# Load .env file automatically (ignored if not present, e.g. on Render/Railway
# where env vars are injected directly by the platform)
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass  # python-dotenv not installed — rely on shell env vars

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from pymongo import MongoClient, DESCENDING, ASCENDING
from bson import ObjectId


# ── IST Timezone ─────────────────────────────────────────────────
# Render servers run UTC. ALL date/time values stored and returned
# by this API are explicitly in Indian Standard Time (UTC+05:30).
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

# ── Config ───────────────────────────────────────────────────────
PORT      = int(os.environ.get("PORT", 3000))

# SECURITY: All secrets MUST come from environment variables.
# Never commit real credentials to source control.
MONGO_URI = os.environ.get("MONGO_URI")
if not MONGO_URI:
    raise RuntimeError(
        "MONGO_URI environment variable is not set. "
        "Example: export MONGO_URI='mongodb+srv://user:pass@cluster/'"
    )

DB_NAME = os.environ.get("MONGO_DB", "kpr_parking")
PUBLIC  = Path(__file__).parent / "public"

# SECURITY: PRINT_SECRET must be set in env; no insecure default.
PRINT_SECRET = os.environ.get("PRINT_SECRET")
if not PRINT_SECRET:
    raise RuntimeError(
        "PRINT_SECRET environment variable is not set. "
        "Set a long random string, e.g.: export PRINT_SECRET='$(openssl rand -hex 32)'"
    )

# SECURITY: Google Sheets webhook URLs — optional, env-only.
GSHEET_ENTRY_URL = os.environ.get("GSHEET_ENTRY_URL", "")
GSHEET_EXIT_URL  = os.environ.get("GSHEET_EXIT_URL",  "")

# SECURITY: Restrict CORS to known origins.
# Set ALLOWED_ORIGINS="https://your-domain.com,https://other.com"
_allowed_origins_raw = os.environ.get("ALLOWED_ORIGINS", "")
ALLOWED_ORIGINS = (
    [o.strip() for o in _allowed_origins_raw.split(",") if o.strip()]
    if _allowed_origins_raw
    else "*"   # falls back to wildcard only if explicitly unset (dev mode)
)

# Input validation limits
MAX_LORRY_LEN   = 20
MAX_NAME_LEN    = 80
MAX_PHONE_LEN   = 20
MAX_REMARKS_LEN = 200
MAX_PAGE_LIMIT  = 500   # cap to prevent full-table dump via ?limit=999999

app = Flask(__name__, static_folder=None)
CORS(app, origins=ALLOWED_ORIGINS)

# ── MongoDB Connection ────────────────────────────────────────────
_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=10000)
_db     = _client[DB_NAME]

records_col     = _db["records"]
settings_col    = _db["settings"]
print_queue_col = _db["print_queue"]
counters_col    = _db["counters"]


def init_db():
    """Create indexes and seed default settings."""
    records_col.create_index("token",      unique=True)
    records_col.create_index("status")
    records_col.create_index("lorry")
    records_col.create_index("entry_date")
    records_col.create_index("exit_date")

    print_queue_col.create_index("status")
    print_queue_col.create_index("seq_id")

    settings_col.update_one(
        {"key": "hourly_rate"},
        {"$setOnInsert": {"key": "hourly_rate", "value": "130"}},
        upsert=True
    )
    counters_col.update_one(
        {"_id": "token"},
        {"$setOnInsert": {"seq": 0}},
        upsert=True
    )
    counters_col.update_one(
        {"_id": "print_queue"},
        {"$setOnInsert": {"seq": 0}},
        upsert=True
    )
    print(f"[KPR] MongoDB connected → {DB_NAME}")


init_db()

# ── Helpers ───────────────────────────────────────────────────────
def next_token() -> int:
    result = counters_col.find_one_and_update(
        {"_id": "token"},
        {"$inc": {"seq": 1}},
        return_document=True,
        upsert=True
    )
    return result["seq"]


def next_seq(counter_id: str) -> int:
    result = counters_col.find_one_and_update(
        {"_id": counter_id},
        {"$inc": {"seq": 1}},
        return_document=True,
        upsert=True
    )
    return result["seq"]


def rec_to_dict(doc) -> dict | None:
    if doc is None:
        return None
    return {
        "id":           str(doc["_id"]),
        "token":        doc.get("token"),
        "lorry":        doc.get("lorry"),
        "driver":       doc.get("driver", "--"),
        "phone":        doc.get("phone",  "--"),
        "remarks":      doc.get("remarks", "--"),
        "entryDate":    doc.get("entry_date"),
        "entryTime":    doc.get("entry_time"),
        "entryDisplay": doc.get("entry_display"),
        "exitDate":     doc.get("exit_date"),
        "exitTime":     doc.get("exit_time"),
        "exitDisplay":  doc.get("exit_display") or "--",
        "durationMin":  doc.get("duration_minutes"),
        "amount":       doc.get("amount"),
        "status":       doc.get("status", "IN"),
        "createdAt":    doc.get("created_at"),
    }


def get_rate() -> float:
    doc = settings_col.find_one({"key": "hourly_rate"})
    return float(doc["value"]) if doc else 130.0


def calc_duration(entry_date: str, entry_time,
                  exit_date: str, exit_time) -> dict:
    """Day-wise billing. Minimum 1 day."""
    try:
        ed   = datetime.date.fromisoformat(entry_date[:10])
        xd   = datetime.date.fromisoformat(exit_date[:10])
        days = max(1, (xd - ed).days)
    except Exception:
        days = 1
    return {"duration_minutes": days * 1440, "billable_days": days}


def today_date() -> str:
    """Today's date in IST — safe on UTC servers (Render)."""
    return datetime.datetime.now(IST).strftime("%Y-%m-%d")


def fmt_display(date_str: str) -> str:
    try:
        dt = datetime.datetime.strptime(date_str[:10], "%Y-%m-%d")
        return dt.strftime("%d/%m/%Y")
    except Exception:
        return date_str


def now_iso() -> str:
    """Current IST timestamp as ISO 8601 string (no tz suffix, IST implied)."""
    return datetime.datetime.now(IST).strftime("%Y-%m-%dT%H:%M:%S")


def ok(data=None, **kwargs):
    payload = {"ok": True}
    if data is not None:
        payload["data"] = data
    payload.update(kwargs)
    return jsonify(payload)


def err(msg: str, status: int = 400):
    return jsonify({"ok": False, "error": msg}), status


def safe_str(value, max_len: int, default: str = "--") -> str:
    """Strip, truncate to max_len, fall back to default."""
    s = (value or "").strip()[:max_len]
    return s if s else default


# ── Google Sheets Helper ─────────────────────────────────────────
def _post_to_sheets(url: str, payload: dict):
    if not url or url.startswith("PASTE_"):
        return

    def _send():
        try:
            import requests as _req
            r = _req.post(url, data=payload, timeout=15, allow_redirects=True)
            if r.status_code == 200:
                print(f"[GSheet] ✓ {payload.get('type','?')} #{payload.get('token','?')} stored OK")
            else:
                print(f"[GSheet] ✗ HTTP {r.status_code} — {r.text[:200]}")
        except Exception as e:
            print(f"[GSheet] Failed: {e}")

    threading.Thread(target=_send, daemon=True).start()


def _to12h(t24):
    if not t24:
        return ""
    try:
        h, m = map(int, t24.split(":"))
        ampm = "PM" if h >= 12 else "AM"
        h12  = h % 12 or 12
        return f"{h12:02d}:{m:02d} {ampm}"
    except Exception:
        return t24


def sheets_entry_payload(rec: dict, rate: float) -> dict:
    return {
        "type":       "ENTRY",
        "timestamp":  datetime.datetime.now(IST).strftime("%d/%m/%Y, %I:%M:%S %p"),
        "token":      rec["token"],
        "lorry":      rec["lorry"],
        "driver":     rec["driver"] if rec["driver"] != "--" else "",
        "phone":      rec["phone"]  if rec["phone"]  != "--" else "",
        "remarks":    rec["remarks"] if rec["remarks"] != "--" else "",
        "entry_date": rec["entryDisplay"] or "",
        "entry_time": _to12h(rec.get("entryTime") or ""),
        "rate":       rate,
    }


def sheets_exit_payload(rec: dict, rate: float, billable_days: int) -> dict:
    days = billable_days or 1
    return {
        "type":       "EXIT",
        "timestamp":  datetime.datetime.now(IST).strftime("%d/%m/%Y, %I:%M:%S %p"),
        "token":      rec["token"],
        "lorry":      rec["lorry"],
        "driver":     rec["driver"] if rec["driver"] != "--" else "",
        "phone":      rec["phone"]  if rec["phone"]  != "--" else "",
        "remarks":    rec["remarks"] if rec["remarks"] != "--" else "",
        "entry_date": rec["entryDisplay"] or "",
        "entry_time": _to12h(rec.get("entryTime") or ""),
        "exit_date":  rec.get("exitDisplay") or "",
        "exit_time":  _to12h(rec.get("exitTime") or ""),
        "duration":   f"{days} Day{'s' if days != 1 else ''}",
        "rate":       rate,
        "amount":     rec.get("amount") or 0,
    }


# ── Static files ──────────────────────────────────────────────────
if PUBLIC.exists():
    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_static(path):
        # SECURITY: Block serving admin.html
        if path and path.lower().startswith("admin"):
            return jsonify({"ok": False, "error": "Not found"}), 404
        if path and (PUBLIC / path).exists():
            return send_from_directory(str(PUBLIC), path)
        return send_from_directory(str(PUBLIC), "index.html")


# ── Auth helper ───────────────────────────────────────────────────
def _check_print_auth():
    return request.headers.get("X-Print-Token", "") == PRINT_SECRET


# ================================================================
#  API ROUTES
# ================================================================

@app.get("/api/health")
def health():
    return ok(db=DB_NAME, timestamp=datetime.datetime.now(IST).isoformat(), timezone="IST")


@app.get("/api/stats")
def stats():
    today = today_date()

    pipeline = [
        {"$group": {
            "_id": None,
            "parked":        {"$sum": {"$cond": [{"$eq": ["$status", "IN"]},  1, 0]}},
            "today_entries": {"$sum": {"$cond": [{"$eq": ["$entry_date", today]}, 1, 0]}},
            "today_exits":   {"$sum": {"$cond": [
                {"$and": [{"$eq": ["$status", "OUT"]}, {"$eq": ["$exit_date", today]}]}, 1, 0
            ]}},
            "today_revenue": {"$sum": {"$cond": [
                {"$and": [{"$eq": ["$status", "OUT"]}, {"$eq": ["$exit_date", today]}]},
                {"$ifNull": ["$amount", 0]}, 0
            ]}},
            "total":         {"$sum": 1},
            "exited":        {"$sum": {"$cond": [{"$eq": ["$status", "OUT"]}, 1, 0]}},
            "total_revenue": {"$sum": {"$cond": [
                {"$eq": ["$status", "OUT"]}, {"$ifNull": ["$amount", 0]}, 0
            ]}},
        }}
    ]

    result = list(records_col.aggregate(pipeline))
    if result:
        r = result[0]
        r.pop("_id", None)
    else:
        r = {
            "parked": 0, "today_entries": 0, "today_exits": 0,
            "today_revenue": 0, "total": 0, "exited": 0, "total_revenue": 0
        }

    return ok(r)


@app.get("/api/settings")
def get_settings():
    docs = settings_col.find({})
    return ok({d["key"]: d["value"] for d in docs})


@app.post("/api/settings")
def post_settings():
    body     = request.get_json(silent=True) or {}
    rate_val = body.get("hourly_rate") or body.get("daily_rate")
    if rate_val is None:
        return err("hourly_rate required")
    try:
        rate = float(rate_val)
        if rate < 1:
            raise ValueError
    except (TypeError, ValueError):
        return err("Invalid rate")

    settings_col.update_one(
        {"key": "hourly_rate"},
        {"$set": {"value": str(rate)}},
        upsert=True
    )
    return ok({"hourly_rate": rate})


@app.get("/api/records")
def get_records():
    q      = request.args.get("q", "").strip()
    status = request.args.get("status", "").strip().upper()

    try:
        page  = max(1, int(request.args.get("page",  "1")))
        limit = min(MAX_PAGE_LIMIT, max(1, int(request.args.get("limit", "200"))))
    except (ValueError, TypeError):
        return err("page and limit must be integers")

    skip = (page - 1) * limit

    filt = {}
    if status in ("IN", "OUT"):
        filt["status"] = status

    if q:
        # SECURITY: re.escape prevents ReDoS via crafted regex input
        safe_q = re.escape(q)
        or_clauses = [
            {"lorry":  {"$regex": safe_q, "$options": "i"}},
            {"driver": {"$regex": safe_q, "$options": "i"}},
        ]
        if q.isdigit():
            or_clauses.append({"token": int(q)})
        filt["$or"] = or_clauses

    docs = list(
        records_col.find(filt)
                   .sort("_id", DESCENDING)
                   .skip(skip)
                   .limit(limit)
    )
    return ok([rec_to_dict(d) for d in docs])


@app.get("/api/records/<rec_id>")
def get_record(rec_id: str):
    try:
        oid = ObjectId(rec_id)
    except Exception:
        return err("Invalid ID", 400)
    doc = records_col.find_one({"_id": oid})
    if not doc:
        return err("Record not found", 404)
    return ok(rec_to_dict(doc))


@app.post("/api/records")
def create_record():
    body  = request.get_json(silent=True) or {}
    lorry = (body.get("lorry") or "").strip().upper()[:MAX_LORRY_LEN]
    if not lorry:
        return err("Lorry number required")

    entry_date = (body.get("entryDate") or today_date())[:10]
    entry_time = (body.get("entryTime") or "")[:5] or None

    # Validate date format
    try:
        datetime.date.fromisoformat(entry_date)
    except ValueError:
        return err("Invalid entryDate format (expected YYYY-MM-DD)")

    # Check for duplicate active entry
    dup = records_col.find_one({"lorry": lorry, "status": "IN"})
    if dup:
        return err(f"{lorry} is already parked with token #{dup['token']}", 409)

    token = next_token()
    doc = {
        "token":            token,
        "lorry":            lorry,
        "driver":           safe_str(body.get("driver"),  MAX_NAME_LEN),
        "phone":            safe_str(body.get("phone"),   MAX_PHONE_LEN),
        "remarks":          safe_str(body.get("remarks"), MAX_REMARKS_LEN),
        "entry_date":       entry_date,
        "entry_time":       entry_time,
        "entry_display":    fmt_display(entry_date),
        "exit_date":        None,
        "exit_time":        None,
        "exit_display":     "--",
        "duration_minutes": None,
        "amount":           None,
        "status":           "IN",
        "created_at":       now_iso(),
    }

    result = records_col.insert_one(doc)
    doc["_id"] = result.inserted_id
    rec = rec_to_dict(doc)

    _post_to_sheets(GSHEET_ENTRY_URL, sheets_entry_payload(rec, get_rate()))
    return ok(rec, message=f"Entry recorded: Token #{token}")


@app.patch("/api/records/<rec_id>/exit")
def exit_record(rec_id: str):
    try:
        oid = ObjectId(rec_id)
    except Exception:
        return err("Invalid ID", 400)

    body      = request.get_json(silent=True) or {}
    exit_date = (body.get("exitDate") or today_date())[:10]
    exit_time = (body.get("exitTime") or "")[:5] or None

    # Validate date format
    try:
        datetime.date.fromisoformat(exit_date)
    except ValueError:
        return err("Invalid exitDate format (expected YYYY-MM-DD)")

    doc = records_col.find_one({"_id": oid})
    if not doc:
        return err("Record not found", 404)
    if doc["status"] == "OUT":
        return err("Vehicle already exited", 400)

    # Validate exit not before entry
    try:
        ed = datetime.date.fromisoformat(doc["entry_date"])
        xd = datetime.date.fromisoformat(exit_date)
        if xd < ed:
            return err("exitDate cannot be before entryDate", 400)
    except Exception:
        pass  # calc_duration will handle gracefully

    dur    = calc_duration(doc["entry_date"], doc.get("entry_time"), exit_date, exit_time)
    rate   = get_rate()
    amount = dur["billable_days"] * rate

    records_col.update_one(
        {"_id": oid},
        {"$set": {
            "exit_date":        exit_date,
            "exit_time":        exit_time,
            "exit_display":     fmt_display(exit_date),
            "duration_minutes": dur["duration_minutes"],
            "amount":           amount,
            "status":           "OUT",
        }}
    )
    updated = records_col.find_one({"_id": oid})
    rec = rec_to_dict(updated)

    _post_to_sheets(GSHEET_EXIT_URL, sheets_exit_payload(rec, rate, dur["billable_days"]))
    return ok(rec, message=f"Exit processed: {dur['billable_days']} day(s), Rs.{amount}")


@app.delete("/api/records/<rec_id>")
def delete_record(rec_id: str):
    try:
        oid = ObjectId(rec_id)
    except Exception:
        return err("Invalid ID", 400)
    result = records_col.delete_one({"_id": oid})
    if result.deleted_count == 0:
        return err("Record not found", 404)
    return ok(message=f"Record {rec_id} deleted")


@app.delete("/api/records")
def delete_all_records():
    body = request.get_json(silent=True) or {}
    if body.get("confirm") != "DELETE_ALL":
        return err("Confirmation required")
    records_col.delete_many({})
    counters_col.update_one({"_id": "token"}, {"$set": {"seq": 0}})
    return ok(message="All records deleted")


@app.post("/api/import")
def import_records():
    body    = request.get_json(silent=True) or {}
    records = body.get("records", [])
    if not records:
        return err("No records provided")

    added  = 0
    errors = []
    rate   = get_rate()

    for i, r in enumerate(records):
        try:
            lorry = (r.get("lorry") or "").strip().upper()[:MAX_LORRY_LEN]
            if not lorry:
                raise ValueError("Missing lorry")

            entry_date = (r.get("entryDate") or today_date())[:10]
            entry_time = (r.get("entryTime") or "")[:5] or None
            exit_date  = (r.get("exitDate")  or "")[:10] or None
            exit_time  = (r.get("exitTime")  or "")[:5]  or None
            status     = "OUT" if exit_date else "IN"

            # Validate dates
            datetime.date.fromisoformat(entry_date)
            if exit_date:
                datetime.date.fromisoformat(exit_date)

            dur    = calc_duration(entry_date, entry_time, exit_date, exit_time) if exit_date else None
            amount = (dur["billable_days"] * rate) if dur else None

            token = int(r["token"]) if r.get("token") else None
            if token and records_col.find_one({"token": token}):
                token = None
            if not token:
                token = next_token()

            doc = {
                "token":            token,
                "lorry":            lorry,
                "driver":           safe_str(r.get("driver"),  MAX_NAME_LEN),
                "phone":            safe_str(r.get("phone"),   MAX_PHONE_LEN),
                "remarks":          safe_str(r.get("remarks"), MAX_REMARKS_LEN),
                "entry_date":       entry_date,
                "entry_time":       entry_time,
                "entry_display":    fmt_display(entry_date),
                "exit_date":        exit_date,
                "exit_time":        exit_time,
                "exit_display":     fmt_display(exit_date) if exit_date else "--",
                "duration_minutes": dur["duration_minutes"] if dur else None,
                "amount":           amount,
                "status":           status,
                "created_at":       now_iso(),
            }
            records_col.insert_one(doc)
            added += 1

        except Exception as e:
            errors.append({"row": i + 1, "error": str(e)})

    resp = {"ok": True, "added": added, "message": f"Imported {added} of {len(records)} records"}
    if errors:
        resp["errors"] = errors
    return jsonify(resp)


# ================================================================
#  PRINT QUEUE
# ================================================================

def pq_to_dict(doc) -> dict:
    return {
        "id":         doc.get("seq_id"),
        "job_data":   doc.get("job_data"),
        "status":     doc.get("status"),
        "created_at": doc.get("created_at"),
        "ack_at":     doc.get("ack_at"),
    }


@app.post("/api/print-queue")
def enqueue_print():
    if not _check_print_auth():
        return err("Unauthorized", 401)
    data = request.get_json(silent=True)
    if not data:
        return err("No JSON body")

    seq_id = next_seq("print_queue")
    doc = {
        "seq_id":     seq_id,
        "job_data":   data,
        "status":     "pending",
        "created_at": now_iso(),
        "ack_at":     None,
    }
    print_queue_col.insert_one(doc)
    return ok({"job_id": seq_id, "message": "Print job queued"})


@app.get("/api/print-queue/pending")
def get_pending_jobs():
    if not _check_print_auth():
        return err("Unauthorized", 401)
    docs = list(
        print_queue_col.find({"status": "pending"}).sort("seq_id", ASCENDING)
    )
    jobs = []
    for doc in docs:
        jobs.append({
            "id":         doc["seq_id"],
            "data":       doc["job_data"],
            "created_at": doc["created_at"],
        })
    return ok(jobs)


@app.route("/api/print-queue/<int:job_id>/ack", methods=["PATCH"])
def ack_print_job(job_id: int):
    if not _check_print_auth():
        return err("Unauthorized", 401)
    body   = request.get_json(silent=True) or {}
    status = "done" if body.get("success", True) else "failed"

    result = print_queue_col.update_one(
        {"seq_id": job_id},
        {"$set": {"status": status, "ack_at": now_iso()}}
    )
    if result.matched_count == 0:
        return err("Job not found", 404)
    return ok({"job_id": job_id, "status": status})


@app.get("/api/print-queue")
def list_print_queue():
    if not _check_print_auth():
        return err("Unauthorized", 401)
    docs = list(print_queue_col.find().sort("seq_id", DESCENDING).limit(100))
    jobs = []
    for doc in docs:
        d = doc.get("job_data", {})
        jobs.append({
            "id":         doc["seq_id"],
            "status":     doc["status"],
            "created_at": doc["created_at"],
            "ack_at":     doc.get("ack_at"),
            "token":      d.get("token"),
            "lorry":      d.get("lorry"),
            "type":       d.get("type"),
        })
    return ok(jobs)


@app.delete("/api/print-queue/<int:job_id>")
def delete_print_job(job_id: int):
    if not _check_print_auth():
        return err("Unauthorized", 401)
    print_queue_col.delete_one({"seq_id": job_id})
    return ok(message=f"Job {job_id} deleted")


@app.delete("/api/print-queue")
def clear_old_print_jobs():
    if not _check_print_auth():
        return err("Unauthorized", 401)
    cutoff = (datetime.datetime.now(IST) - datetime.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S")
    print_queue_col.delete_many({
        "status":     {"$ne": "pending"},
        "created_at": {"$lt": cutoff}
    })
    return ok(message="Old jobs cleaned up")



# ── API catch-all — must be LAST route registered ────────────────
# Catches any /api/* path that has no matching route (e.g. /api/admin/*)
# Without this, Flask's static file handler serves index.html (200)
# for unmatched GET requests instead of a proper 404.
@app.route("/api/<path:subpath>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
def api_catch_all(subpath):
    return err(f"Endpoint /api/{subpath} not found", 404)


# ── Run ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"🚛 KPR Transport API running at http://localhost:{PORT}")
    print(f"🍃 Database: MongoDB Atlas → {DB_NAME}")
    print(f"🗓  Billing: DAY-WISE — (exitDate − entryDate) days × rate (min 1 day)")
    print(f"🖨  Print Queue: enabled")
    app.run(host="0.0.0.0", port=PORT, debug=False)