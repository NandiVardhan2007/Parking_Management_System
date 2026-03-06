# ================================================================
#  KPR TRANSPORT PARKING SYSTEM — Python Backend
#  server.py  |  Flask + MongoDB Atlas
# ================================================================

import os, re, datetime, threading
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from pymongo import MongoClient, DESCENDING, ASCENDING
from pymongo.errors import DuplicateKeyError, PyMongoError
from bson import ObjectId

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

PORT         = int(os.environ.get("PORT", 3000))
MONGO_URI    = os.environ.get("MONGO_URI", "")
DB_NAME      = os.environ.get("MONGO_DB", "kpr_parking")
PRINT_SECRET = os.environ.get("PRINT_SECRET", "")
PUBLIC       = Path(__file__).parent / "public"
GSHEET_ENTRY_URL = os.environ.get("GSHEET_ENTRY_URL", "")
GSHEET_EXIT_URL  = os.environ.get("GSHEET_EXIT_URL", "")

_allowed_origins_raw = os.environ.get("ALLOWED_ORIGINS", "")
ALLOWED_ORIGINS = (
    [o.strip() for o in _allowed_origins_raw.split(",") if o.strip()]
    if _allowed_origins_raw else "*"
)

MAX_LORRY_LEN   = 20
MAX_NAME_LEN    = 80
MAX_PHONE_LEN   = 20
MAX_REMARKS_LEN = 200
MAX_PAGE_LIMIT  = 500

app = Flask(__name__, static_folder=None)
CORS(app, origins=ALLOWED_ORIGINS)

_client = _db = records_col = settings_col = print_queue_col = counters_col = None


def get_db():
    global _client, _db, records_col, settings_col, print_queue_col, counters_col
    if _db is not None:
        return None
    if not MONGO_URI:
        return "MONGO_URI not set. Add it in Render Dashboard → Environment."
    try:
        _client         = MongoClient(MONGO_URI, serverSelectionTimeoutMS=10000)
        _db             = _client[DB_NAME]
        records_col     = _db["records"]
        settings_col    = _db["settings"]
        print_queue_col = _db["print_queue"]
        counters_col    = _db["counters"]
        _client.admin.command("ping")
        _init_db()
        print(f"[KPR] MongoDB connected to {DB_NAME}")
        return None
    except Exception as exc:
        _db = None
        return f"MongoDB error: {exc}"


# ── FIX: dedicated helper that always resyncs the counter ────────
def _sync_token_counter():
    """
    Ensure the token counter document is >= the highest token
    that actually exists in records_col.

    Call this:
      1. On every startup (inside _init_db)
      2. Inside the DuplicateKeyError handler in create_record()
      3. After bulk import

    This makes the counter self-healing: even if Render restarts and
    the counters collection is somehow reset (or behind), the very
    next entry attempt will recover automatically.
    """
    try:
        max_doc   = records_col.find_one({}, sort=[("token", DESCENDING)])
        max_token = int(max_doc["token"]) if max_doc else 0

        # Create if not exists, initialised to max_token
        counters_col.update_one(
            {"_id": "token"},
            {"$setOnInsert": {"seq": max_token}},
            upsert=True,
        )
        # If the document already exists but is BEHIND, bring it up
        counters_col.update_one(
            {"_id": "token", "seq": {"$lt": max_token}},
            {"$set": {"seq": max_token}},
        )
        print(f"[KPR] Token counter synced: max_existing={max_token}")
        return max_token
    except Exception as e:
        print(f"[KPR] _sync_token_counter error: {e}")
        return 0


def _init_db():
    for idx_kwargs in [
        {"keys": "token",      "unique": True},
        {"keys": "status"},
        {"keys": "lorry"},
        {"keys": "entry_date"},
        {"keys": "exit_date"},
    ]:
        try:
            records_col.create_index(**idx_kwargs)
        except Exception:
            pass
    for col, key in [(print_queue_col, "status"), (print_queue_col, "seq_id")]:
        try:
            col.create_index(key)
        except Exception:
            pass

    settings_col.update_one(
        {"key": "hourly_rate"},
        {"$setOnInsert": {"key": "hourly_rate", "value": "130"}},
        upsert=True,
    )

    # Always sync on startup — handles counter resets after redeploy
    _sync_token_counter()

    counters_col.update_one(
        {"_id": "print_queue"},
        {"$setOnInsert": {"seq": 0}},
        upsert=True,
    )


_startup_err = get_db()
if _startup_err:
    print(f"[KPR] WARNING — DB not ready at startup: {_startup_err}")
else:
    print("[KPR] Database ready")


def require_db():
    db_err = get_db()
    if db_err:
        return jsonify({"ok": False, "error": db_err}), 503
    return None

def next_token():
    r = counters_col.find_one_and_update(
        {"_id": "token"}, {"$inc": {"seq": 1}},
        return_document=True, upsert=True,
    )
    return r["seq"]

def next_seq(cid):
    r = counters_col.find_one_and_update(
        {"_id": cid}, {"$inc": {"seq": 1}},
        return_document=True, upsert=True,
    )
    return r["seq"]

def rec_to_dict(doc):
    if doc is None:
        return None
    return {
        "id":           str(doc["_id"]),
        "token":        doc.get("token"),
        "lorry":        doc.get("lorry"),
        "driver":       doc.get("driver", "--"),
        "phone":        doc.get("phone", "--"),
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

def get_rate():
    try:
        doc = settings_col.find_one({"key": "hourly_rate"})
        return float(doc["value"]) if doc else 130.0
    except Exception:
        return 130.0

def calc_duration(entry_date, entry_time, exit_date, exit_time):
    try:
        ed   = datetime.date.fromisoformat(str(entry_date)[:10])
        xd   = datetime.date.fromisoformat(str(exit_date)[:10])
        days = max(1, (xd - ed).days)
    except Exception:
        days = 1
    return {"duration_minutes": days * 1440, "billable_days": days}

def today_date():
    return datetime.datetime.now(IST).strftime("%Y-%m-%d")

def fmt_display(date_str):
    try:
        return datetime.datetime.strptime(str(date_str)[:10], "%Y-%m-%d").strftime("%d/%m/%Y")
    except Exception:
        return str(date_str)

def now_iso():
    return datetime.datetime.now(IST).strftime("%Y-%m-%dT%H:%M:%S")

def ok(data=None, **kwargs):
    p = {"ok": True}
    if data is not None:
        p["data"] = data
    p.update(kwargs)
    return jsonify(p)

def err(msg, status=400):
    return jsonify({"ok": False, "error": str(msg)}), status

def safe_str(v, max_len, default="--"):
    s = (v or "").strip()[:max_len]
    return s if s else default

def _to12h(t24):
    if not t24:
        return ""
    try:
        h, m = map(int, t24.split(":"))
        return f"{h%12 or 12:02d}:{m:02d} {'PM' if h>=12 else 'AM'}"
    except Exception:
        return t24

def _post_to_sheets(url, payload):
    if not url:
        return
    def _send():
        try:
            import requests as _req
            r = _req.post(url, data=payload, timeout=15, allow_redirects=True)
            print(f"[GSheet] {r.status_code}")
        except Exception as e:
            print(f"[GSheet] Failed: {e}")
    threading.Thread(target=_send, daemon=True).start()

def _check_print_auth():
    return bool(PRINT_SECRET) and request.headers.get("X-Print-Token", "") == PRINT_SECRET


# ── Static files ──────────────────────────────────────────────────
if PUBLIC.exists():
    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_static(path):
        if path and path.lower().startswith("admin"):
            return err("Not found", 404)
        if path and (PUBLIC / path).exists():
            return send_from_directory(str(PUBLIC), path)
        return send_from_directory(str(PUBLIC), "index.html")


# ================================================================
#  API ROUTES
# ================================================================

@app.get("/api/health")
def health():
    db_err = get_db()
    counter_seq = None
    max_token   = None
    try:
        if counters_col is not None:
            cdoc = counters_col.find_one({"_id": "token"})
            counter_seq = cdoc["seq"] if cdoc else 0
        if records_col is not None:
            mdoc = records_col.find_one({}, sort=[("token", DESCENDING)])
            max_token = mdoc["token"] if mdoc else 0
    except Exception:
        pass
    return jsonify({
        "ok":                  db_err is None,
        "db":                  "connected" if db_err is None else f"error: {db_err}",
        "timestamp":           datetime.datetime.now(IST).isoformat(),
        "timezone":            "IST",
        "mongo_uri_set":       bool(MONGO_URI),
        "print_secret_set":    bool(PRINT_SECRET),
        "token_counter":       counter_seq,
        "max_token_in_db":     max_token,
        "counter_in_sync":     counter_seq == max_token if (counter_seq is not None and max_token is not None) else None,
    })


@app.get("/api/stats")
def stats():
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        today = today_date()
        pipeline = [{"$group": {"_id": None,
            "parked":        {"$sum": {"$cond": [{"$eq": ["$status","IN"]}, 1, 0]}},
            "today_entries": {"$sum": {"$cond": [{"$eq": ["$entry_date", today]}, 1, 0]}},
            "today_exits":   {"$sum": {"$cond": [{"$and":[{"$eq":["$status","OUT"]},{"$eq":["$exit_date",today]}]}, 1, 0]}},
            "today_revenue": {"$sum": {"$cond": [{"$and":[{"$eq":["$status","OUT"]},{"$eq":["$exit_date",today]}]}, {"$ifNull":["$amount",0]}, 0]}},
            "total":         {"$sum": 1},
            "exited":        {"$sum": {"$cond": [{"$eq":["$status","OUT"]}, 1, 0]}},
            "total_revenue": {"$sum": {"$cond": [{"$eq":["$status","OUT"]}, {"$ifNull":["$amount",0]}, 0]}},
        }}]
        result = list(records_col.aggregate(pipeline))
        r = result[0] if result else {"parked":0,"today_entries":0,"today_exits":0,"today_revenue":0,"total":0,"exited":0,"total_revenue":0}
        r.pop("_id", None)
        return ok(r)
    except Exception as exc:
        print(f"[KPR] /api/stats error: {exc}")
        return err(f"Stats error: {exc}", 500)


@app.get("/api/settings")
def get_settings():
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        return ok({d["key"]: d["value"] for d in settings_col.find({})})
    except Exception as exc:
        print(f"[KPR] GET /api/settings error: {exc}")
        return err(f"Settings error: {exc}", 500)


@app.post("/api/settings")
def post_settings():
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        body     = request.get_json(silent=True) or {}
        rate_val = body.get("hourly_rate") or body.get("daily_rate")
        if rate_val is None:
            return err("hourly_rate required")
        rate = float(rate_val)
        if rate < 1:
            return err("Rate must be at least 1")
        settings_col.update_one({"key":"hourly_rate"}, {"$set":{"value":str(rate)}}, upsert=True)
        return ok({"hourly_rate": rate})
    except ValueError:
        return err("Invalid rate value")
    except Exception as exc:
        print(f"[KPR] POST /api/settings error: {exc}")
        return err(f"Settings update error: {exc}", 500)


@app.get("/api/records")
def get_records():
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        q      = request.args.get("q", "").strip()
        status = request.args.get("status", "").strip().upper()
        page   = max(1, int(request.args.get("page", "1")))
        limit  = min(MAX_PAGE_LIMIT, max(1, int(request.args.get("limit", "200"))))
        filt   = {}
        if status in ("IN", "OUT"):
            filt["status"] = status
        if q:
            safe_q = re.escape(q)
            clauses = [{"lorry": {"$regex": safe_q, "$options":"i"}},
                       {"driver":{"$regex": safe_q, "$options":"i"}}]
            if q.isdigit():
                clauses.append({"token": int(q)})
            filt["$or"] = clauses
        docs = list(records_col.find(filt).sort("_id", DESCENDING).skip((page-1)*limit).limit(limit))
        return ok([rec_to_dict(d) for d in docs])
    except Exception as exc:
        print(f"[KPR] GET /api/records error: {exc}")
        return err(f"Fetch records error: {exc}", 500)


@app.get("/api/records/<rec_id>")
def get_record(rec_id):
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        doc = records_col.find_one({"_id": ObjectId(rec_id)})
        if not doc:
            return err("Record not found", 404)
        return ok(rec_to_dict(doc))
    except Exception as exc:
        print(f"[KPR] GET /api/records/{rec_id} error: {exc}")
        return err(f"Get record error: {exc}", 500)


@app.post("/api/records")
def create_record():
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        body  = request.get_json(silent=True) or {}
        lorry = (body.get("lorry") or "").strip().upper()[:MAX_LORRY_LEN]
        if not lorry:
            return err("Lorry number required")

        entry_date = (body.get("entryDate") or today_date())[:10]
        entry_time = (body.get("entryTime") or "")[:5] or None

        try:
            datetime.date.fromisoformat(entry_date)
        except ValueError:
            return err("Invalid entryDate — expected YYYY-MM-DD")

        dup = records_col.find_one({"lorry": lorry, "status": "IN"})
        if dup:
            return err(f"{lorry} is already parked (Token #{dup['token']})", 409)

        token = next_token()
        doc = {
            "token": token, "lorry": lorry,
            "driver":   safe_str(body.get("driver"),  MAX_NAME_LEN),
            "phone":    safe_str(body.get("phone"),   MAX_PHONE_LEN),
            "remarks":  safe_str(body.get("remarks"), MAX_REMARKS_LEN),
            "entry_date": entry_date, "entry_time": entry_time,
            "entry_display": fmt_display(entry_date),
            "exit_date": None, "exit_time": None, "exit_display": "--",
            "duration_minutes": None, "amount": None,
            "status": "IN", "created_at": now_iso(),
        }

        # ── SELF-HEALING retry loop ──────────────────────────────────
        # On DuplicateKeyError the counter was behind the actual records
        # (e.g. after a Render restart where counters collection reset).
        # We resync it to the real max and retry — up to 5 times.
        for _attempt in range(5):
            try:
                result = records_col.insert_one(doc.copy())
                doc["_id"] = result.inserted_id
                break
            except DuplicateKeyError:
                print(f"[KPR] DuplicateKeyError token={token} attempt={_attempt+1} — resyncing counter")
                _sync_token_counter()   # ← bring counter up to real max
                token      = next_token()
                doc["token"] = token
        else:
            return err("Could not assign unique token after 5 attempts — please retry", 500)

        rec  = rec_to_dict(doc)
        rate = get_rate()
        _post_to_sheets(GSHEET_ENTRY_URL, {
            "type":"ENTRY","token":rec["token"],"lorry":rec["lorry"],
            "driver":rec["driver"] if rec["driver"]!="--" else "",
            "phone": rec["phone"]  if rec["phone"] !="--" else "",
            "entry_date":rec["entryDisplay"],"entry_time":_to12h(rec.get("entryTime") or ""),
            "rate":rate,"timestamp":datetime.datetime.now(IST).strftime("%d/%m/%Y, %I:%M:%S %p"),
        })
        return ok(rec, message=f"Entry recorded: Token #{token}")

    except Exception as exc:
        print(f"[KPR] POST /api/records error: {exc}")
        return err(f"Entry failed: {exc}", 500)


@app.patch("/api/records/<rec_id>/exit")
def exit_record(rec_id):
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        oid = ObjectId(rec_id)
    except Exception:
        return err("Invalid record ID", 400)
    try:
        body      = request.get_json(silent=True) or {}
        exit_date = (body.get("exitDate") or today_date())[:10]
        exit_time = (body.get("exitTime") or "")[:5] or None

        try:
            datetime.date.fromisoformat(exit_date)
        except ValueError:
            return err("Invalid exitDate — expected YYYY-MM-DD")

        doc = records_col.find_one({"_id": oid})
        if not doc:
            return err("Record not found", 404)
        if doc["status"] == "OUT":
            return err("Vehicle already exited", 400)

        try:
            if datetime.date.fromisoformat(exit_date) < datetime.date.fromisoformat(doc["entry_date"]):
                return err("Exit date cannot be before entry date", 400)
        except Exception:
            pass

        dur    = calc_duration(doc["entry_date"], doc.get("entry_time"), exit_date, exit_time)
        rate   = get_rate()
        amount = dur["billable_days"] * rate

        records_col.update_one({"_id": oid}, {"$set": {
            "exit_date": exit_date, "exit_time": exit_time,
            "exit_display": fmt_display(exit_date),
            "duration_minutes": dur["duration_minutes"],
            "amount": amount, "status": "OUT",
        }})

        updated = records_col.find_one({"_id": oid})
        rec = rec_to_dict(updated)
        _post_to_sheets(GSHEET_EXIT_URL, {
            "type":"EXIT","token":rec["token"],"lorry":rec["lorry"],
            "driver":rec["driver"] if rec["driver"]!="--" else "",
            "phone": rec["phone"]  if rec["phone"] !="--" else "",
            "entry_date":rec["entryDisplay"],"entry_time":_to12h(rec.get("entryTime") or ""),
            "exit_date":rec.get("exitDisplay"),"exit_time":_to12h(rec.get("exitTime") or ""),
            "duration":f"{dur['billable_days']} Day{'s' if dur['billable_days']!=1 else ''}",
            "rate":rate,"amount":amount,
            "timestamp":datetime.datetime.now(IST).strftime("%d/%m/%Y, %I:%M:%S %p"),
        })
        return ok(rec, message=f"Exit processed: {dur['billable_days']} day(s), Rs.{amount}")

    except Exception as exc:
        print(f"[KPR] PATCH /api/records/{rec_id}/exit error: {exc}")
        return err(f"Exit failed: {exc}", 500)


@app.delete("/api/records/<rec_id>")
def delete_record(rec_id):
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        result = records_col.delete_one({"_id": ObjectId(rec_id)})
        if result.deleted_count == 0:
            return err("Record not found", 404)
        return ok(message=f"Record {rec_id} deleted")
    except Exception as exc:
        print(f"[KPR] DELETE /api/records/{rec_id} error: {exc}")
        return err(f"Delete failed: {exc}", 500)


@app.delete("/api/records")
def delete_all_records():
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        body = request.get_json(silent=True) or {}
        if body.get("confirm") != "DELETE_ALL":
            return err("Confirmation required: send {confirm: 'DELETE_ALL'}")
        records_col.delete_many({})
        counters_col.update_one({"_id":"token"}, {"$set":{"seq":0}})
        return ok(message="All records deleted")
    except Exception as exc:
        print(f"[KPR] DELETE /api/records error: {exc}")
        return err(f"Clear failed: {exc}", 500)


@app.post("/api/import")
def import_records():
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        body    = request.get_json(silent=True) or {}
        records = body.get("records", [])
        if not records:
            return err("No records provided")
        added, errors, rate = 0, [], get_rate()
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
                datetime.date.fromisoformat(entry_date)
                if exit_date: datetime.date.fromisoformat(exit_date)
                dur    = calc_duration(entry_date, entry_time, exit_date, exit_time) if exit_date else None
                amount = (dur["billable_days"] * rate) if dur else None
                token  = int(r["token"]) if r.get("token") else None
                if token and records_col.find_one({"token": token}): token = None
                if not token: token = next_token()
                records_col.insert_one({
                    "token":token,"lorry":lorry,
                    "driver": safe_str(r.get("driver"),  MAX_NAME_LEN),
                    "phone":  safe_str(r.get("phone"),   MAX_PHONE_LEN),
                    "remarks":safe_str(r.get("remarks"), MAX_REMARKS_LEN),
                    "entry_date":entry_date,"entry_time":entry_time,"entry_display":fmt_display(entry_date),
                    "exit_date":exit_date,"exit_time":exit_time,"exit_display":fmt_display(exit_date) if exit_date else "--",
                    "duration_minutes":dur["duration_minutes"] if dur else None,
                    "amount":amount,"status":status,"created_at":now_iso(),
                })
                added += 1
            except Exception as e:
                errors.append({"row":i+1,"error":str(e)})

        # Always resync after bulk import to prevent drift
        _sync_token_counter()

        resp = {"ok":True,"added":added,"message":f"Imported {added} of {len(records)} records"}
        if errors: resp["errors"] = errors
        return jsonify(resp)
    except Exception as exc:
        print(f"[KPR] POST /api/import error: {exc}")
        return err(f"Import failed: {exc}", 500)


# ── Print Queue ───────────────────────────────────────────────────
@app.post("/api/print-queue")
def enqueue_print():
    if not _check_print_auth(): return err("Unauthorized", 401)
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        data = request.get_json(silent=True)
        if not data: return err("No JSON body")
        seq_id = next_seq("print_queue")
        print_queue_col.insert_one({"seq_id":seq_id,"job_data":data,"status":"pending","created_at":now_iso(),"ack_at":None})
        return ok({"job_id":seq_id,"message":"Print job queued"})
    except Exception as exc:
        return err(f"Print queue error: {exc}", 500)

@app.get("/api/print-queue/pending")
def get_pending_jobs():
    if not _check_print_auth(): return err("Unauthorized", 401)
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        docs = list(print_queue_col.find({"status":"pending"}).sort("seq_id", ASCENDING))
        return ok([{"id":d["seq_id"],"data":d["job_data"],"created_at":d["created_at"]} for d in docs])
    except Exception as exc:
        return err(f"Fetch error: {exc}", 500)

@app.route("/api/print-queue/<int:job_id>/ack", methods=["PATCH"])
def ack_print_job(job_id):
    if not _check_print_auth(): return err("Unauthorized", 401)
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        body   = request.get_json(silent=True) or {}
        status = "done" if body.get("success", True) else "failed"
        result = print_queue_col.update_one({"seq_id":job_id},{"$set":{"status":status,"ack_at":now_iso()}})
        if result.matched_count == 0: return err("Job not found", 404)
        return ok({"job_id":job_id,"status":status})
    except Exception as exc:
        return err(f"Ack error: {exc}", 500)

@app.get("/api/print-queue")
def list_print_queue():
    if not _check_print_auth(): return err("Unauthorized", 401)
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        docs = list(print_queue_col.find().sort("seq_id", DESCENDING).limit(100))
        return ok([{"id":d["seq_id"],"status":d["status"],"created_at":d["created_at"],"ack_at":d.get("ack_at"),
                    "token":d.get("job_data",{}).get("token"),"lorry":d.get("job_data",{}).get("lorry"),
                    "type":d.get("job_data",{}).get("type")} for d in docs])
    except Exception as exc:
        return err(f"List error: {exc}", 500)

@app.delete("/api/print-queue/<int:job_id>")
def delete_print_job(job_id):
    if not _check_print_auth(): return err("Unauthorized", 401)
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        print_queue_col.delete_one({"seq_id": job_id})
        return ok(message=f"Job {job_id} deleted")
    except Exception as exc:
        return err(f"Delete error: {exc}", 500)

@app.delete("/api/print-queue")
def clear_old_print_jobs():
    if not _check_print_auth(): return err("Unauthorized", 401)
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        cutoff = (datetime.datetime.now(IST) - datetime.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S")
        print_queue_col.delete_many({"status":{"$ne":"pending"},"created_at":{"$lt":cutoff}})
        return ok(message="Old jobs cleaned up")
    except Exception as exc:
        return err(f"Cleanup error: {exc}", 500)


# ── Admin: manual counter resync ──────────────────────────────────
@app.post("/api/admin/resync-counter")
def resync_counter():
    """
    Force-resync the token counter to the actual max in the DB.
    Use this ONCE on an existing deployment to fix the restarted tokens.
    Requires X-Print-Token header for auth.
    """
    if not _check_print_auth():
        return err("Unauthorized — send X-Print-Token header", 401)
    db_resp = require_db()
    if db_resp: return db_resp
    try:
        new_max = _sync_token_counter()
        cdoc    = counters_col.find_one({"_id": "token"})
        seq     = cdoc["seq"] if cdoc else 0
        return ok({
            "max_token_found":    new_max,
            "counter_now":        seq,
            "next_token_will_be": seq + 1,
        })
    except Exception as exc:
        return err(f"Resync failed: {exc}", 500)


@app.route("/api/<path:subpath>", methods=["GET","POST","PUT","PATCH","DELETE"])
def api_catch_all(subpath):
    return err(f"Endpoint /api/{subpath} not found", 404)


if __name__ == "__main__":
    print(f"KPR Transport Parking  ->  http://localhost:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)