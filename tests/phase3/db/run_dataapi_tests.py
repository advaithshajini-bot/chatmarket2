#!/usr/bin/env python3
"""
tests/phase3/db/run_dataapi_tests.py

Data API test for the W1 boundary (architecture v10 §2, tests 44 and 47): the
worker path is  Data API + server-side key -> exposed wrapper -> private function.

It starts a REAL PostgREST (the component behind the Supabase Data API) against
the throwaway local database and makes real HTTP requests with role-bearing
JWTs. This is NOT Supabase's gateway: Supabase translates a secret key into a
service_role-authenticated request; here the equivalent is a JWT whose role
claim is service_role. The database-side behaviour under test (which Postgres
role executes the call, and what that role may execute) is the same.

    POSTGREST_BIN=/path/to/postgrest python3 tests/phase3/db/run_dataapi_tests.py
"""
import base64, hashlib, hmac, json, os, subprocess, sys, time, uuid, urllib.request, urllib.error
import psycopg2

HOST = os.environ.get("PGHOST", "127.0.0.1"); PORT = int(os.environ.get("PGPORT", "54329")); DB = os.environ.get("PGDATABASE", "cm")
BIN = os.environ.get("POSTGREST_BIN", "postgrest")
API = "http://127.0.0.1:3399"
SECRET = "test-only-jwt-secret-0123456789-abcdefghijklmnop"

def conn(user):
    c = psycopg2.connect(host=HOST, port=PORT, user=user, dbname=DB); c.autocommit = True; return c
def q(c, sql, p=None):
    cur = c.cursor(); cur.execute(sql, p)
    try: return cur.fetchall()
    except psycopg2.ProgrammingError: return []

def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def jwt(claims):
    h = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()); p = b64(json.dumps(claims).encode())
    sig = b64(hmac.new(SECRET.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
    return f"{h}.{p}.{sig}"

def call(method, path, token=None, body=None, headers=None):
    req = urllib.request.Request(API + path, method=method, data=(json.dumps(body).encode() if body is not None else None))
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    for k, v in (headers or {}).items(): req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw.decode()

OWNER, SU = conn("mig_owner"), conn("postgres")
results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS  " if cond else "FAIL  ") + name + (f"   [{detail}]" if (detail and not cond) else ""))

# ---- fixtures (throwaway DB) ------------------------------------------------
cfg = {"goal": "g", "inputs": [], "outputs": [], "tools": [], "modelPolicy": {"provider": "anthropic"},
       "steps": [{"id": "s0", "kind": "transform", "config": {}, "timeoutSeconds": 30, "retryLimit": 1}],
       "limits": {"maxSteps": 1, "maxCostInr": 20, "timeoutSeconds": 300}}
def uid():
    u = str(uuid.uuid4()); q(SU, "insert into auth.users (id,email) values (%s,%s)", (u, u + "@t")); q(SU, "insert into public.profiles (id,is_admin) values (%s,false)", (u,)); return u
seller, buyer, admin = uid(), uid(), uid()
q(SU, "update public.profiles set is_admin=true where id=%s", (admin,))
listing = str(uuid.uuid4())
q(OWNER, "insert into public.listings (id,seller_id,product_type,status,configuration) values (%s,%s,'workflow','live',%s)", (listing, seller, json.dumps(cfg)))
q(OWNER, "insert into public.entitlements (user_id,product_id,kind,status) values (%s,%s,'purchase','active')", (buyer, listing))
q(OWNER, "update private.feature_flags set enabled=true where name='phase3_execution'")
run = q(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (buyer, listing))[0][0]
claim = q(OWNER, "select private.claim_next_step(%s)", (run,))[0][0]
step, rc = claim["step_id"], claim["retry_count"]
snap = lambda: q(OWNER, "select r.status, s.status, s.retry_count from public.runs r join public.run_steps s on s.run_id=r.id where r.id=%s", (run,))

# ---- start PostgREST ----------------------------------------------------------
conf = f"""db-uri = "postgres://authenticator@{HOST}:{PORT}/{DB}"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "{SECRET}"
server-host = "127.0.0.1"
server-port = 3399
"""
open("/tmp/pgrst.conf", "w").write(conf)
proc = subprocess.Popen([BIN, "/tmp/pgrst.conf"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
try:
    for _ in range(100):      # ready only when the schema cache is loaded (HTTP 200); 503 = still loading
        try:
            if urllib.request.urlopen(API + "/", timeout=1).status == 200: break
        except Exception: pass
        time.sleep(0.2)
    else:
        raise SystemExit("PostgREST did not become ready")

    SVC = jwt({"role": "service_role"})
    AUTH = lambda sub: jwt({"role": "authenticated", "sub": sub})
    payload = lambda rc_: {"p_run_id": run, "p_step_id": step, "p_expected_retry_count": rc_, "p_error": "boom"}
    before = snap()

    # denied callers first (state must not move) ---------------------------------
    code, body = call("POST", "/rpc/worker_retry_or_fail_step", None, payload(rc))
    check("DA anon (no token) is denied on the wrapper", code in (401, 403) and isinstance(body, dict) and body.get("code") == "42501", f"{code} {body}")
    for label, sub in (("buyer", buyer), ("product creator", seller), ("admin user", admin)):
        code, body = call("POST", "/rpc/worker_retry_or_fail_step", AUTH(sub), payload(rc))
        check(f"DA authenticated {label} is denied on the wrapper (403, 42501)", code == 403 and body.get("code") == "42501", f"{code} {body}")
    check("DA denied Data API calls changed nothing", snap() == before, str(snap()))

    # the private function / lifecycle functions are unreachable through the Data API ---
    for fn in ("retry_or_fail_step", "claim_next_step", "checkpoint_step", "cancel_run", "create_run", "recover_stale_run", "decide_approval"):
        code, _ = call("POST", f"/rpc/{fn}", SVC, {})
        check(f"DA private function {fn} is not reachable in the exposed schema (service_role, 404)", code == 404, str(code))
    code, body = call("POST", "/rpc/retry_or_fail_step", SVC, payload(rc), {"Content-Profile": "private"})
    check("DA the `private` schema is not exposed even when requested via Content-Profile", code in (400, 406), f"{code} {body}")
    code, body = call("POST", "/rpc/retry_or_fail_step", SVC, payload(rc), {"Content-Profile": "private"})

    # worker path: Data API + service_role -> wrapper -> private function ---------
    code, body = call("POST", "/rpc/worker_retry_or_fail_step", SVC, payload(99))
    check("DA worker path: stale/wrong fence is rejected by the wrapper and changes nothing", code == 200 and body == {"outcome": "rejected", "reason": "fencing_mismatch"} and snap() == before, f"{code} {body}")
    code, body = call("POST", "/rpc/worker_retry_or_fail_step", SVC, payload(rc))
    check("DA worker path: service_role -> wrapper -> private.retry_or_fail_step succeeds (retried, retry_count 1)",
          code == 200 and body.get("outcome") == "retried" and body.get("retry_count") == 1, f"{code} {body}")
    check("DA the retry transition committed atomically (run running, step pending, retry_count 1)", snap() == [("running", "pending", 1)], str(snap()))
    code, body = call("POST", "/rpc/worker_retry_or_fail_step", SVC, payload(rc))
    check("DA replaying the OLD fence after the retry is rejected (no double retry)", code == 200 and body.get("outcome") == "rejected", f"{code} {body}")
    check("DA still exactly one retry", snap() == [("running", "pending", 1)])

    # RLS through the Data API is unchanged -------------------------------------
    code, body = call("GET", f"/runs?id=eq.{run}&select=id,status", AUTH(buyer))
    check("DA the buyer can read their own run through RLS", code == 200 and len(body) == 1, f"{code} {body}")
    code, body = call("PATCH", f"/run_steps?run_id=eq.{run}", AUTH(buyer), {"retry_count": 0}, {"Prefer": "return=representation"})
    check("DA the buyer cannot rewrite retry_count via the Data API (0 rows updated)", code in (200, 204, 403) and (body in ([], None, "") or code == 403), f"{code} {body}")
    check("DA retry_count unchanged after the attempted rewrite", snap() == [("running", "pending", 1)], str(snap()))
finally:
    proc.terminate()
    try: proc.wait(5)
    except Exception: proc.kill()
    q(OWNER, "update private.feature_flags set enabled=false where name='phase3_execution'")

failed = [n for n, ok in results if not ok]
print(f"\n=== Data API: {len(results) - len(failed)} passed, {len(failed)} failed ===")
sys.exit(1 if failed else 0)
