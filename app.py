from flask import Flask, request, jsonify, render_template, redirect, url_for, session
from flask_cors import CORS
import sqlite3, os, json, re, random, hashlib
from datetime import datetime, timezone
from pathlib import Path
import secrets, os
import time

app = Flask(__name__, instance_relative_config=True)

# garante instance/
Path(app.instance_path).mkdir(parents=True, exist_ok=True)

key_file = Path(app.instance_path) / "secret_key"
if key_file.exists():
    app.secret_key = key_file.read_text().strip()
else:
    key = secrets.token_hex(32)
    key_file.write_text(key)
    app.secret_key = key

CORS(app)

# --- paths/DB ---
Path(app.instance_path).mkdir(parents=True, exist_ok=True)
DB_PATH = os.path.join(app.instance_path, "pool.db")

# --- CONFIG: Schulte + DDA ---
SCHULTE_BASE_SIZE = 5
SCHULTE_MIN_SIZE  = 5
SCHULTE_MAX_SIZE  = 15

# DDA (alvo de tempo e histerese)
DDA_TARGET_SEC  = 120
DDA_WINDOW      = 5
DDA_FAST_FACTOR = 0.9   # < 80% do alvo = rápido -> aumenta grade
DDA_SLOW_FACTOR = 1.1   # >110% do alvo = lento  -> diminui grade

# PoW: dificuldade base e passo ligado ao tamanho
POW_DIFF_BASE = 2     # nº mínimo de zeros no hash
POW_DIFF_STEP = 0       # 0 = PoW fixo | 1 = sobe 1 a cada +2 no tamanho
MAX_DIFF      = 4
GENESIS_HASH = "0"*64


# --- SCHEMA ---
SCHEMA = """
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  school TEXT NOT NULL,
  grp TEXT,
  joined_at TEXT NOT NULL,
  CONSTRAINT uq_name_school UNIQUE(name, school)
);

CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  mined_at   TEXT,
  miner_id   INTEGER,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  task_json      TEXT NOT NULL,
  solution_json  TEXT NOT NULL,
  -- PoW
  prev_hash  TEXT,
  difficulty INTEGER NOT NULL DEFAULT 3,
  nonce      INTEGER,
  hash       TEXT,
  FOREIGN KEY(miner_id) REFERENCES participants(id)
);
"""

def get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)
init_db()

# --- helpers ---
MAX_LEN = 120

def sanitize(s: str) -> str:
    if not isinstance(s, str):
        return ""
    s = re.sub(r"[\r\n]+", " ", s).strip()
    return s[:MAX_LEN]

def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def parse_iso_z(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)

def row_to_participant(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "name": r["name"], "school": r["school"], "group": r["grp"], "joined_at": r["joined_at"]}

def row_to_block(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "created_at": r["created_at"],
        "mined_at": r["mined_at"],
        "miner_id": r["miner_id"],
        "width": r["width"],
        "height": r["height"],
        "task": json.loads(r["task_json"]),
        "solution": json.loads(r["solution_json"]),
        "prev_hash": r["prev_hash"],
        "difficulty": r["difficulty"],
        "nonce": r["nonce"],
        "hash": r["hash"],
    }

def difficulty_for_size(size: int) -> int:
    # 5x5/6x6 -> 2 zeros; 7x7/8x8 -> 3; 9x9/10x10 -> 4
    table = {
        5:5, 6:6,
        7:7, 8:8,
        9:9, 10:10,
        11:11, 12:12
    }
    return table.get(size, 3)

def gen_schulte(size: int = SCHULTE_BASE_SIZE):
    vals = list(range(1, size*size + 1))
    random.shuffle(vals)
    grid = [vals[i*size:(i+1)*size] for i in range(size)]
    task = {"type": "schulte", "size": size, "grid": grid}
    solution = {}  # Schulte valida por sequência; não há solução fixa
    return task, solution

def calc_next_schulte_size(conn) -> int:
    rows = conn.execute(
        "SELECT id, created_at, mined_at, width FROM blocks WHERE mined_at IS NOT NULL ORDER BY id DESC LIMIT ?",
        (DDA_WINDOW,)
    ).fetchall()
    last_size = rows[0]["width"] if rows else SCHULTE_BASE_SIZE
    if not rows:
        return last_size
    times = []
    for r in rows:
        try:
            t0 = parse_iso_z(r["created_at"])
            t1 = parse_iso_z(r["mined_at"])
            dt = (t1 - t0).total_seconds()
            if dt > 0: times.append(dt)
        except Exception:
            pass
    if not times:
        return last_size
    # EMA
    alpha = 0.5
    ema = None
    for t in reversed(times):
        ema = t if ema is None else alpha*t + (1 - alpha)*ema
    fast_th = DDA_TARGET_SEC * DDA_FAST_FACTOR
    slow_th = DDA_TARGET_SEC * DDA_SLOW_FACTOR
    if ema is not None and ema < fast_th and last_size < SCHULTE_MAX_SIZE:
        return last_size + 1
    if ema is not None and ema > slow_th and last_size > SCHULTE_MIN_SIZE:
        return last_size - 1
    return last_size

def compute_pow(prev_hash: str, task_json: str, miner_tag: str, difficulty: int):
    """
    Retorna (nonce, hash, meta).
    - real: brute force até achar prefixo de '0'*difficulty
    - bounded: tenta até POW_BOUNDED_ITERS*(difficulty-1 ou 1); se não achar, forja
    - fake: forja o hash com zeros no começo; nonce pequeno e determinístico
    """
    diff = int(difficulty)
    prefix = "0" * diff
    POW_MODE = "fake"

    if POW_MODE == "real":
        nonce = 0
        while True:
            payload = f"{prev_hash}|{task_json}|{miner_tag}|{nonce}".encode()
            h = hashlib.sha256(payload).hexdigest()
            if h.startswith(prefix):
                return nonce, h, {"mode": "real", "iters": nonce + 1}
            nonce += 1

    elif POW_MODE == "bounded":
        # Tenta um pouco para "mostrar trabalho", depois forja se não achar
        max_iters = POW_BOUNDED_ITERS * max(1, diff - 1)
        nonce = 0
        while nonce < max_iters:
            payload = f"{prev_hash}|{task_json}|{miner_tag}|{nonce}".encode()
            h = hashlib.sha256(payload).hexdigest()
            if h.startswith(prefix):
                return nonce, h, {"mode": "bounded", "iters": nonce + 1, "found": True}
            nonce += 1
        # não achou: forja
        payload = f"{prev_hash}|{task_json}|{miner_tag}|{nonce}".encode()
        h = hashlib.sha256(payload).hexdigest()
        fake_hash = prefix + h[diff:]
        return nonce, fake_hash, {"mode": "bounded", "iters": max_iters, "found": False}

    else:  # POW_MODE == "fake"
        # Nonce determinístico e pequeno (para ficar "bonito")
        base = f"{prev_hash}|{task_json}|{miner_tag}".encode()
        seed = int(hashlib.sha256(base).hexdigest(), 16) & 0xFFFFFFFF
        nonce = seed % 100_000
        h = hashlib.sha256(f"{prev_hash}|{task_json}|{miner_tag}|{nonce}".encode()).hexdigest()
        fake_hash = prefix + h[diff:]  # força os zeros iniciais
        return nonce, fake_hash, {"mode": "fake"}

def ensure_open_block(conn, force_new: bool = False) -> sqlite3.Row:
    """Retorna o bloco aberto ou cria um novo. Nunca minera sozinho."""
    if not force_new:
        row = conn.execute(
            "SELECT * FROM blocks WHERE mined_at IS NULL ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row:
            # se já é Schulte válido, devolve
            try:
                t = json.loads(row["task_json"])
            except Exception:
                t = None
            if isinstance(t, dict) and t.get("type") == "schulte":
                return row

            # reescreve bloco aberto ruim
            size = calc_next_schulte_size(conn)
            task, sol = gen_schulte(size)
            diff = difficulty_for_size(size)
            now  = now_iso()
            prev = conn.execute(
                "SELECT hash FROM blocks WHERE mined_at IS NOT NULL ORDER BY id DESC LIMIT 1"
            ).fetchone()
            prev_hash = prev["hash"] if prev and prev["hash"] else GENESIS_HASH

            conn.execute(
                "UPDATE blocks SET created_at=?, width=?, height=?, task_json=?, solution_json=?, "
                "prev_hash=?, difficulty=?, nonce=NULL, hash=NULL WHERE id=?",
                (now, size, size, json.dumps(task), json.dumps(sol),
                 prev_hash, diff, row["id"])
            )
            conn.commit()
            print(f"[BLOCK] reaberto id={row['id']} size={size}x{size} diff={diff} prev={prev_hash[:8]}…")
            return conn.execute("SELECT * FROM blocks WHERE id=?", (row["id"],)).fetchone()

    # criar novo
    size = calc_next_schulte_size(conn)
    task, sol = gen_schulte(size)
    diff = difficulty_for_size(size)
    now  = now_iso()
    prev = conn.execute(
        "SELECT hash FROM blocks WHERE mined_at IS NOT NULL ORDER BY id DESC LIMIT 1"
    ).fetchone()
    prev_hash = prev["hash"] if prev and prev["hash"] else GENESIS_HASH

    cur = conn.execute(
        "INSERT INTO blocks(created_at,width,height,task_json,solution_json,prev_hash,difficulty) "
        "VALUES (?,?,?,?,?,?,?)",
        (now, size, size, json.dumps(task), json.dumps(sol), prev_hash, diff)
    )
    conn.commit()
    new_id = cur.lastrowid
    print(f"[BLOCK] novo id={new_id} size={size}x{size} diff={diff} prev={prev_hash[:8]}…")
    return conn.execute("SELECT * FROM blocks WHERE id=?", (new_id,)).fetchone()

# ---------------- Páginas ----------------
@app.get("/")
def index():
    return render_template("index.html")

@app.post("/join")
def join():
    name = sanitize(request.form.get("name", ""))
    school = sanitize(request.form.get("school", ""))
    grp = sanitize(request.form.get("group", ""))
    if not name or not school:
        return jsonify({"error": "Campos obrigatórios: name, school"}), 400
    now = now_iso()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO participants(name, school, grp, joined_at) VALUES (?,?,?,?) "
            "ON CONFLICT(name, school) DO UPDATE SET grp=excluded.grp",
            (name, school, grp or None, now)
        )
        pid = conn.execute("SELECT id FROM participants WHERE name=? AND school=?", (name, school)).fetchone()[0]
        conn.commit()
        session["participant_id"] = pid
        session["participant_name"] = name
        session["participant_school"] = school
    return redirect(url_for("mine"))

@app.get("/mine")
def mine():
    return render_template("mine.html")

@app.get('/favicon.ico')
def favicon():
    return ("", 204)

# ---------------- REST: Participants/Leaderboard ----------------
@app.get("/api/participants")
def list_participants():
    try:
        limit = max(1, min(int(request.args.get("limit", 200)), 500))
        offset = max(0, int(request.args.get("offset", 0)))
    except ValueError:
        return jsonify({"error":"limit/offset inválidos"}), 400
    q = sanitize(request.args.get("q", ""))
    school = sanitize(request.args.get("school",""))
    order = request.args.get("order","asc").lower()
    if order not in ("asc","desc"): order="asc"

    sql = "SELECT id,name,school,grp,joined_at FROM participants WHERE 1=1"
    params=[]
    if q:
        like=f"%{q}%"
        sql += " AND (name LIKE ? OR school LIKE ? OR COALESCE(grp,'') LIKE ?)"
        params += [like,like,like]
    if school:
        sql += " AND school=?"; params.append(school)

    sql_count="SELECT COUNT(*) FROM ("+sql+")"
    sql += f" ORDER BY datetime(joined_at) {order.upper()} LIMIT ? OFFSET ?"
    params_count=list(params); params += [limit, offset]

    with get_conn() as conn:
        total=conn.execute(sql_count, params_count).fetchone()[0]
        rows=conn.execute(sql, params).fetchall()
    return jsonify({"items":[row_to_participant(r) for r in rows], "total": total, "limit": limit, "offset": offset})

@app.get("/api/leaderboard")
def api_leaderboard():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT p.name, p.school, COUNT(b.id) AS wins "
            "FROM blocks b JOIN participants p ON p.id=b.miner_id "
            "WHERE b.mined_at IS NOT NULL "
            "GROUP BY p.id ORDER BY wins DESC, MIN(b.mined_at) ASC"
        ).fetchall()
    return jsonify({"items":[dict(r) for r in rows]})

# ---------------- REST: Blocks/Puzzle ----------------
@app.get("/api/blocks")
def api_blocks():
    limit = int(request.args.get("limit", 20))
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT b.*, p.name AS miner_name, p.school AS miner_school "
            "FROM blocks b LEFT JOIN participants p ON p.id=b.miner_id "
            "ORDER BY id ASC"
        ).fetchall()
    # não vaza task/solution
    items=[]
    for r in rows[-limit:]:
        d = dict(r)
        d["task_json"] = None
        d["solution_json"] = None
        d["miner_name"] = r["miner_name"]
        d["miner_school"] = r["miner_school"]
        items.append(d)
    return jsonify({"items": items})

@app.get("/api/block/current")
def api_block_current():
    with get_conn() as conn:
        row = ensure_open_block(conn)
        b = row_to_block(row)
        task = b["task"]
        # retorna só o necessário ao front
        return jsonify({
            "id": b["id"],
            "created_at": b["created_at"],
            "type": task.get("type", "schulte"),
            "difficulty": b["difficulty"],
            "task": task  # {size, grid}
        })

@app.post("/api/block/submit")
@app.post("/api/block/submit")
def api_block_submit():
    pid = session.get("participant_id")
    if not pid:
        return jsonify({"error":"você precisa entrar na pool primeiro"}), 400
    body = request.get_json(silent=True) or {}
    positions = body.get("positions")  # [[r,c], ...]

    with get_conn() as conn:
        row = ensure_open_block(conn)
        b = row_to_block(row)
        t = b["task"]
        if t.get("type") != "schulte":
            return jsonify({"error": "puzzle atual não é schulte"}), 400
        size = int(t["size"]); grid = t["grid"]

        # valida: 1..N na ordem
        ok = True; expected = 1
        if not isinstance(positions, list) or len(positions) != size*size:
            ok = False
        else:
            for r,c in positions:
                try:
                    val = int(grid[int(r)][int(c)])
                except Exception:
                    ok = False; break
                if val != expected:
                    ok = False; break
                expected += 1
        if not ok:
            return jsonify({"ok": False, "reason":"sequência incorreta"}), 200

        # corrida
        if b["mined_at"] is not None:
            return jsonify({"ok": False, "reason":"bloco já minerado"}), 200

        # PoW (com log de tempo)
        miner_tag = f"{session.get('participant_name','')}|{session.get('participant_school','')}"
        prev = b["prev_hash"] or GENESIS_HASH
        t0 = time.perf_counter()
        # PoW (com log de tempo e info do modo)
        miner_tag = f"{session.get('participant_name','')}|{session.get('participant_school','')}"
        prev = b["prev_hash"] or GENESIS_HASH
        t0 = time.perf_counter()
        nonce, h, meta = compute_pow(prev, json.dumps(t, sort_keys=True), miner_tag, int(b["difficulty"]))
        elapsed = time.perf_counter() - t0
        iters = meta.get("iters")
        extra = f" iters={iters}" if iters is not None else ""
        print(f"[PoW-{meta.get('mode')}] block#{b['id']} diff={b['difficulty']}{extra} em {elapsed:.3f}s (nonce={nonce})")
        print(f"[PoW] block#{b['id']} diff={b['difficulty']} levou {elapsed:.3f}s (nonce={nonce})")

        now = now_iso()
        cur = conn.execute(
            "UPDATE blocks SET mined_at=?, miner_id=?, nonce=?, hash=? WHERE id=? AND mined_at IS NULL",
            (now, pid, nonce, h, b["id"])
        )
        conn.commit()
        if cur.rowcount == 0:
            return jsonify({"ok": False, "reason":"bloco já minerado"}), 200

        # abre o próximo bloco (DDA aplicada)
        ensure_open_block(conn, force_new=True)

        winner = conn.execute("SELECT name, school FROM participants WHERE id=?", (pid,)).fetchone()
        return jsonify({"ok": True,
                        "winner": {"name": winner["name"], "school": winner["school"]},
                        "pow": {"nonce": nonce, "hash": h}})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
