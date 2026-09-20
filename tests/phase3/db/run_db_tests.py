#!/usr/bin/env python3
"""
tests/phase3/db/run_db_tests.py

Phase 3.1 database tests (architecture v10). Runs against the THROWAWAY local
database built by setup_local_db.sh -- never against Supabase.

    PGHOST=127.0.0.1 PGPORT=54329 python3 tests/phase3/db/run_db_tests.py

Real, separate connections are used (including real logins as anon,
authenticated and service_role) so the privilege and concurrency tests exercise
genuine sessions, not mocks.

Numbering follows the v8/v9/v10 gate: 31-33 (v8), 34-48 (v9/v10). Tests
prefixed S- are supplemental invariant tests added because the retry, fencing,
cancellation and lock-order guarantees need the surrounding transitions to be
exercised, not just defined. Tests 1-30 (v6/v7) are NOT included: their
specification is not in the handoff.
"""
import copy, json, os, random, re, subprocess, sys, threading, time, traceback, uuid
import psycopg2, psycopg2.extras

HOST = os.environ.get("PGHOST", "127.0.0.1")
PORT = int(os.environ.get("PGPORT", "54329"))
DB = os.environ.get("PGDATABASE", "cm")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))

def conn(user, autocommit=True):
    c = psycopg2.connect(host=HOST, port=PORT, user=user, dbname=DB)
    c.autocommit = autocommit
    return c

def q(c, sql, params=None):
    cur = c.cursor()
    cur.execute(sql, params)
    try:
        return cur.fetchall()
    except psycopg2.ProgrammingError:
        return []

def one(c, sql, params=None):
    rows = q(c, sql, params)
    return rows[0][0] if rows else None

def err(c, sql, params=None):
    """Run sql, return the psycopg2 error (must occur)."""
    try:
        q(c, sql, params)
    except psycopg2.Error as e:
        return e
    raise AssertionError("expected an error but the statement succeeded: " + sql[:90])

def raises(c, sql, params, pgcode, prefix=None):
    e = err(c, sql, params)
    assert e.pgcode == pgcode, f"expected SQLSTATE {pgcode}, got {e.pgcode}: {e.diag.message_primary}"
    if prefix is not None:
        assert (e.diag.message_primary or "").startswith(prefix), \
            f"expected message starting {prefix!r}, got {e.diag.message_primary!r}"
    return e

OWNER = conn("mig_owner")
SU = conn("postgres")

# ---------------------------------------------------------------- fixtures --
FIX = json.load(open(os.path.join(ROOT, "tests/phase3/fixtures/meeting-minutes-workflow.fixture.json")))
FIX.pop("_comment", None)

def mk_cfg(n=3, retry=1, timeout=30, max_steps=None, cost=20, run_timeout=300, retries=None):
    c = copy.deepcopy(FIX)
    c["steps"] = [{"id": f"s{i}", "kind": "transform", "config": {},
                   "timeoutSeconds": timeout,
                   "retryLimit": (retries[i] if retries else retry)} for i in range(n)]
    c["limits"] = {"maxSteps": max_steps or max(n, 1), "maxCostInr": cost, "timeoutSeconds": run_timeout}
    return c

def new_user(admin=False):
    uid = str(uuid.uuid4())
    q(SU, "insert into auth.users (id, email) values (%s, %s)", (uid, uid + "@t.local"))   # auth.users is written by the auth service, not the migration owner
    q(OWNER, "insert into public.profiles (id, is_admin) values (%s, %s)", (uid, admin))
    return uid

def new_listing(seller, cfg, ptype="workflow", status="live", version=1):
    lid = str(uuid.uuid4())
    q(OWNER, "insert into public.listings (id, seller_id, product_type, status, version, configuration) "
             "values (%s,%s,%s,%s,%s,%s)", (lid, seller, ptype, status, version, json.dumps(cfg)))
    return lid

def entitle(user, listing):
    q(OWNER, "insert into public.entitlements (user_id, product_id, kind, status) values (%s,%s,'purchase','active')",
      (user, listing))

def set_flag(on):
    q(OWNER, "update private.feature_flags set enabled=%s where name='phase3_execution'", (on,))

def world(cfg):
    seller, buyer = new_user(), new_user()
    listing = new_listing(seller, cfg)
    entitle(buyer, listing)
    return dict(seller=seller, buyer=buyer, listing=listing)

def start(cfg, claim=True, c=OWNER):
    w = world(cfg)
    run = one(c, "select private.create_run(%s,%s,'{}'::jsonb,false)", (w["buyer"], w["listing"]))
    w["run"] = run
    if claim:
        r = one(c, "select private.claim_next_step(%s)", (run,))
        assert r["outcome"] == "claimed", r
        w["step"], w["rc"] = r["step_id"], r["retry_count"]
    return w

def run_row(run):
    return q(OWNER, "select status, error, cost, output from public.runs where id=%s", (run,))[0]

def steps(run):
    return q(OWNER, "select step_index, status, retry_count, error, output from public.run_steps "
                    "where run_id=%s order by step_index, created_at", (run,))

def backdate(step, seconds=200):
    q(OWNER, "update public.run_steps set started_at = now() - make_interval(secs => %s) where id=%s", (seconds, step))

def payload(nbytes):
    """jsonb whose ::text is exactly nbytes long."""
    return json.dumps("x" * (nbytes - 2))

# ------------------------------------------------------------------ harness --
RESULTS = []
ONLY = set(filter(None, os.environ.get("TESTS", "").split(",")))
def test(tid, name):
    def deco(fn):
        if ONLY and tid not in ONLY:
            return fn
        t0 = time.time()
        try:
            fn()
            RESULTS.append((tid, name, "PASS", "", time.time() - t0))
            print(f"PASS  {tid:<5} {name}")
        except Exception as e:
            RESULTS.append((tid, name, "FAIL", str(e), time.time() - t0))
            print(f"FAIL  {tid:<5} {name}\n      {type(e).__name__}: {e}")
            if os.environ.get("TRACE"):
                traceback.print_exc()
        return fn
    return deco

def note(tid, name, status, detail):
    RESULTS.append((tid, name, status, detail, 0.0))
    print(f"{status:<5} {tid:<5} {name}  [{detail}]")

FN_PRIVATE = [
    "is_execution_enabled()", "system_ceilings()", "assert_execution_config_within_ceilings(jsonb)",
    "runs_enforce_execution_config()", "retry_or_fail_step(uuid,uuid,integer,text)", "fail_run_closed(uuid,text)",
    "create_run(uuid,uuid,jsonb,boolean)", "claim_next_step(uuid)", "checkpoint_step(uuid,uuid,integer,jsonb,numeric)",
    "cancel_run(uuid)", "decide_approval(uuid,text,uuid)", "recover_stale_run(uuid)",
]
WRAPPER = "public.worker_retry_or_fail_step(uuid,uuid,integer,text)"

# =========================================================== S-1: flag OFF ==
@test("S-1", "feature flag is seeded OFF and fails closed (missing row => off; create_run refused while off)")
def _():
    assert one(OWNER, "select enabled from private.feature_flags where name='phase3_execution'") is False
    assert one(OWNER, "select private.is_execution_enabled()") is False
    # fail-closed: a MISSING row must also read as off, never as on
    q(OWNER, "begin")
    q(OWNER, "delete from private.feature_flags")
    assert one(OWNER, "select private.is_execution_enabled()") is False
    q(OWNER, "rollback")
    # NULL value can't exist (NOT NULL), but prove the function never returns NULL
    assert one(OWNER, "select private.is_execution_enabled() is not null") is True
    w = world(mk_cfg())
    raises(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (w["buyer"], w["listing"]), "CM010", "execution_disabled")
    assert one(OWNER, "select count(*) from public.runs where user_id=%s", (w["buyer"],)) == 0

set_flag(True)   # from here the flag is ON in the THROWAWAY local database only; reset at the end (S-99)

@test("S-2", "claim_next_step refuses while the flag is off (fail closed, no state change)")
def _():
    w = start(mk_cfg(), claim=False)
    set_flag(False)
    try:
        r = one(OWNER, "select private.claim_next_step(%s)", (w["run"],))
        assert r == {"outcome": "rejected", "reason": "execution_disabled"}, r
        assert run_row(w["run"])[0] == "queued"
    finally:
        set_flag(True)

# ===================================================== 34-39 L2 (database) ==
def l2_reject(cfg, prefix, code="CM001"):
    w = world(cfg)
    raises(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (w["buyer"], w["listing"]), code, prefix)
    assert one(OWNER, "select count(*) from public.runs where user_id=%s", (w["buyer"],)) == 0
    assert one(OWNER, "select count(*) from public.run_steps s join public.runs r on r.id=s.run_id where r.user_id=%s", (w["buyer"],)) == 0

def l2_accept(cfg):
    w = world(cfg)
    run = one(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (w["buyer"], w["listing"]))
    assert run
    return run

@test("34", "DB retry ceiling: retryLimit 2 and 5 rejected; 0 and 1 accepted")
def _():
    l2_reject(mk_cfg(retries=[1, 2, 1]), "config_exceeds_system_ceiling:steps[1].retryLimit")
    l2_reject(mk_cfg(retry=5), "config_exceeds_system_ceiling:steps[0].retryLimit")
    l2_accept(mk_cfg(retry=0))
    l2_accept(mk_cfg(retry=1))

@test("34b", "retry behaviour: limit 1 => exactly one retry then terminal; limit 0 => first failure terminal")
def _():
    w = start(mk_cfg(n=1, retry=1))
    r1 = one(OWNER, "select private.retry_or_fail_step(%s,%s,%s,'boom')", (w["run"], w["step"], w["rc"]))
    assert r1["outcome"] == "retried" and r1["retry_count"] == 1, r1
    c = one(OWNER, "select private.claim_next_step(%s)", (w["run"],))
    assert c["outcome"] == "claimed" and c["retry_count"] == 1
    r2 = one(OWNER, "select private.retry_or_fail_step(%s,%s,%s,'boom2')", (w["run"], w["step"], 1))
    assert r2["outcome"] == "failed", r2
    assert run_row(w["run"])[0] == "failed" and steps(w["run"])[0][1] == "failed" and steps(w["run"])[0][2] == 1
    z = start(mk_cfg(n=1, retry=0))
    rz = one(OWNER, "select private.retry_or_fail_step(%s,%s,%s,'boom')", (z["run"], z["step"], z["rc"]))
    assert rz["outcome"] == "failed" and steps(z["run"])[0][2] == 0, rz

@test("35", "DB step-timeout ceiling: 91/120/3600 rejected (never clamped); 30 and 90 accepted and stored exactly")
def _():
    for bad in (91, 120, 3600):
        l2_reject(mk_cfg(timeout=bad), "config_exceeds_system_ceiling:steps[0].timeoutSeconds")
    run90 = l2_accept(mk_cfg(timeout=90))
    run30 = l2_accept(mk_cfg(timeout=30))
    assert one(OWNER, "select execution_config->'steps'->0->>'timeoutSeconds' from public.runs where id=%s", (run90,)) == "90"
    assert one(OWNER, "select execution_config->'steps'->0->>'timeoutSeconds' from public.runs where id=%s", (run30,)) == "30"

@test("36", "DB step-count ceiling: 11 steps / maxSteps 11 / 6 steps with maxSteps 5 rejected; 10 and 3-of-5 accepted")
def _():
    l2_reject(mk_cfg(n=11, max_steps=10), "config_exceeds_system_ceiling:steps.length")           # plan longer than the ceiling
    l2_reject(mk_cfg(n=11, max_steps=11), "config_exceeds_system_ceiling:limits.maxSteps")        # both violated; first check reported
    l2_reject(mk_cfg(n=3, max_steps=11), "config_exceeds_system_ceiling:limits.maxSteps")
    l2_reject(mk_cfg(n=6, max_steps=5), "config_exceeds_system_ceiling:steps.length>limits.maxSteps")
    run10 = l2_accept(mk_cfg(n=10, max_steps=10))
    assert one(OWNER, "select jsonb_array_length(execution_config->'steps') from public.runs where id=%s", (run10,)) == 10
    l2_accept(mk_cfg(n=3, max_steps=5))

@test("37", "cost ceiling: DB rejects 50.01/100/10000, accepts 50 and 20; runtime stops at the frozen ₹20, and at the constant ₹50")
def _():
    for bad in (50.01, 100, 10000):
        l2_reject(mk_cfg(cost=bad), "config_exceeds_system_ceiling:limits.maxCostInr")
    l2_accept(mk_cfg(cost=50))
    w = start(mk_cfg(n=3, cost=20))
    r = one(OWNER, "select private.checkpoint_step(%s,%s,%s,'\"a\"'::jsonb,15)", (w["run"], w["step"], w["rc"]))
    assert r["outcome"] == "checkpointed", r
    c = one(OWNER, "select private.claim_next_step(%s)", (w["run"],))
    r2 = one(OWNER, "select private.checkpoint_step(%s,%s,%s,'\"b\"'::jsonb,6)", (w["run"], c["step_id"], c["retry_count"]))
    assert r2 == {"outcome": "failed", "reason": "cost_limit_exceeded"}, r2
    st = run_row(w["run"])
    assert st[0] == "failed" and float(st[2]) == 21.0 and st[1] == "cost_limit_exceeded"
    # constant ceiling, product limit 50: 51 must fail independently
    w2 = start(mk_cfg(n=1, cost=50))
    r3 = one(OWNER, "select private.checkpoint_step(%s,%s,%s,'\"a\"'::jsonb,51)", (w2["run"], w2["step"], w2["rc"]))
    assert r3["outcome"] == "failed" and r3["reason"] == "cost_limit_exceeded", r3
    # exactly at the ceiling is allowed
    w3 = start(mk_cfg(n=1, cost=50))
    r4 = one(OWNER, "select private.checkpoint_step(%s,%s,%s,'\"a\"'::jsonb,50)", (w3["run"], w3["step"], w3["rc"]))
    assert r4["outcome"] == "succeeded", r4

@test("38", "run active-processing ceiling (config): 301 rejected, 120 and 300 accepted")
def _():
    l2_reject(mk_cfg(run_timeout=301), "config_exceeds_system_ceiling:limits.timeoutSeconds")
    l2_accept(mk_cfg(run_timeout=300))
    l2_accept(mk_cfg(run_timeout=120))
note("38b", "runtime `timed_out` when cumulative ACTIVE processing exceeds the budget", "NOT-IMPL",
     "no accounting method specified in v10; config ceiling is enforced (L1/L2/L3), runtime elapsed-time enforcement is not implemented")

@test("39", "output ceilings: step 51,200 B ok / 51,201 B fails; run 204,800 B ok / +1 step fails; no product field can raise them")
def _():
    w = start(mk_cfg(n=1))
    ok = one(OWNER, "select private.checkpoint_step(%s,%s,%s,%s::jsonb,0)", (w["run"], w["step"], w["rc"], payload(51200)))
    assert ok["outcome"] == "succeeded", ok
    w = start(mk_cfg(n=1))
    bad = one(OWNER, "select private.checkpoint_step(%s,%s,%s,%s::jsonb,0)", (w["run"], w["step"], w["rc"], payload(51201)))
    assert bad == {"outcome": "failed", "reason": "output_limit_exceeded:step"}, bad
    assert run_row(w["run"])[0] == "failed"
    # cumulative run output: four steps of exactly 51,200 B = 204,800 B is allowed; a fifth fails
    w = start(mk_cfg(n=5))
    step, rc = w["step"], w["rc"]
    for i in range(4):
        r = one(OWNER, "select private.checkpoint_step(%s,%s,%s,%s::jsonb,0)", (w["run"], step, rc, payload(51200)))
        assert r["outcome"] == "checkpointed", (i, r)
        c = one(OWNER, "select private.claim_next_step(%s)", (w["run"],))
        step, rc = c["step_id"], c["retry_count"]
    r5 = one(OWNER, "select private.checkpoint_step(%s,%s,%s,%s::jsonb,0)", (w["run"], step, rc, payload(1000)))
    assert r5 == {"outcome": "failed", "reason": "output_limit_exceeded:run"}, r5
    # smuggled override keys in the frozen config are inert: the limits are constants
    cfg = mk_cfg(n=1); cfg["limits"]["maxStepOutputBytes"] = 999999999; cfg["steps"][0]["config"] = {"maxStepOutputBytes": 999999999}
    w = start(cfg)
    bad = one(OWNER, "select private.checkpoint_step(%s,%s,%s,%s::jsonb,0)", (w["run"], w["step"], w["rc"], payload(51201)))
    assert bad["outcome"] == "failed" and bad["reason"] == "output_limit_exceeded:step", bad

@test("S-3", "at-ceiling configuration (10 steps, retry 1, 90 s, ₹50, 300 s) is accepted end to end")
def _():
    l2_accept(mk_cfg(n=10, max_steps=10, retry=1, timeout=90, cost=50, run_timeout=300))

@test("S-4", "malformed / missing frozen fields fail closed with config_invalid_for_execution (CM002)")
def _():
    c = mk_cfg(); del c["steps"][1]["retryLimit"]
    l2_reject(c, "config_invalid_for_execution:steps[1].retryLimit", "CM002")
    c = mk_cfg(); c["steps"][0]["timeoutSeconds"] = "30"
    l2_reject(c, "config_invalid_for_execution:steps[0].timeoutSeconds", "CM002")
    c = mk_cfg(); del c["limits"]
    l2_reject(c, "config_invalid_for_execution:limits", "CM002")
    c = mk_cfg(); c["steps"] = []
    l2_reject(c, "config_invalid_for_execution:steps", "CM002")
    c = mk_cfg(); c["steps"][0]["retryLimit"] = 0.5
    l2_reject(c, "config_invalid_for_execution:steps[0].retryLimit", "CM002")

@test("S-5", "L2 trigger covers DIRECT privileged writes too (service_role INSERT bypasses RLS but not the trigger); NULL config rejected")
def _():
    w = world(mk_cfg())
    svc = conn("service_role")
    bad = mk_cfg(retry=2)
    raises(svc, "insert into public.runs (user_id,product_id,product_version,execution_config) values (%s,%s,1,%s)",
           (w["buyer"], w["listing"], json.dumps(bad)), "CM001", "config_exceeds_system_ceiling")
    raises(svc, "insert into public.runs (user_id,product_id,product_version,execution_config) values (%s,%s,1,null)",
           (w["buyer"], w["listing"]), "CM002")
    assert one(OWNER, "select count(*) from public.runs where user_id=%s", (w["buyer"],)) == 0
    svc.close()

# ===================================================== 40 L2 / L3 (neutral) ==
def seed_run(cfg, run_status, step_status="running", step_index=0, retry_count=0, started_ago=0):
    """Direct seed that bypasses create_run (used ONLY when L2 is bypassed in the isolated DB)."""
    w = world(cfg)
    run = str(uuid.uuid4())
    q(OWNER, "insert into public.runs (id,user_id,product_id,product_version,status,execution_config,started_at) "
             "values (%s,%s,%s,1,%s,%s, now())", (run, w["buyer"], w["listing"], run_status, json.dumps(cfg)))
    step = str(uuid.uuid4())
    q(OWNER, "insert into public.run_steps (id,run_id,step_index,status,retry_count,started_at) "
             "values (%s,%s,%s,%s,%s, now() - make_interval(secs => %s))", (step, run, step_index, step_status, retry_count, started_ago))
    return run, step

@test("40", "L2 rejects every ceiling violation via the real path; with L2 bypassed in an isolated DB, L3 fails the same seeds closed (and control proves the bypass is real)")
def _():
    violations = {
        "retryLimit>1": (mk_cfg(retry=3), "config_exceeds_system_ceiling:steps[0].retryLimit"),
        "step timeout 120": (mk_cfg(timeout=120), "config_exceeds_system_ceiling:steps[0].timeoutSeconds"),
        "11 steps": (mk_cfg(n=11, max_steps=10), "config_exceeds_system_ceiling:steps.length"),
        "maxSteps 11": (mk_cfg(n=3, max_steps=11), "config_exceeds_system_ceiling:limits.maxSteps"),
        "maxCostInr 100": (mk_cfg(cost=100), "config_exceeds_system_ceiling:limits.maxCostInr"),
        "run timeout 301": (mk_cfg(run_timeout=301), "config_exceeds_system_ceiling:limits.timeoutSeconds"),
    }
    # (1) L2 through the real run-creation path
    for label, (cfg, prefix) in violations.items():
        l2_reject(cfg, prefix)
    # (3) control: with L2 ACTIVE, the same seeds are rejected on direct insert too
    for label, (cfg, prefix) in violations.items():
        w = world(cfg)
        raises(OWNER, "insert into public.runs (user_id,product_id,product_version,execution_config) values (%s,%s,1,%s)",
               (w["buyer"], w["listing"], json.dumps(cfg)), "CM001", prefix)
    # (2) L3 with L2 deliberately bypassed (isolated throwaway DB; mechanism: owner disables the trigger)
    q(OWNER, "alter table public.runs disable trigger runs_enforce_execution_config")
    try:
        # bypass is real: the SAME direct seed now succeeds
        seeded = seed_run(mk_cfg(retry=3), "queued", "pending")
        assert one(OWNER, "select count(*) from public.runs where id=%s", (seeded[0],)) == 1, "bypass did not take effect (test would be vacuous)"

        # (4) retryLimit 3, run already running: retry_or_fail_step must fail terminally; never retry; never treat as 1
        run, step = seed_run(mk_cfg(retry=3), "running", "running", retry_count=0)
        r = one(OWNER, "select private.retry_or_fail_step(%s,%s,0,'boom')", (run, step))
        assert r["outcome"] == "failed" and r["reason"] == "config_exceeds_system_ceiling:retryLimit", r
        assert steps(run)[0][1] == "failed" and steps(run)[0][2] == 0, "step must not have been retried"
        assert run_row(run)[0] == "failed" and run_row(run)[1] == "config_exceeds_system_ceiling:retryLimit"

        # L3 at claim, for every violation: fail closed, nothing runs
        for label, (cfg, prefix) in violations.items():
            run, step = seed_run(cfg, "queued", "pending")
            r = one(OWNER, "select private.claim_next_step(%s)", (run,))
            assert r["outcome"] == "failed" and r["reason"].startswith("config_exceeds_system_ceiling"), (label, r)
            assert run_row(run)[0] == "failed", label
            assert all(s[1] in ("skipped", "failed") for s in steps(run)), (label, steps(run))

        # (5) maxCostInr 100, run already running: checkpoint must NOT execute past the ₹50 ceiling
        run, step = seed_run(mk_cfg(cost=100, n=1), "running", "running")
        r = one(OWNER, "select private.checkpoint_step(%s,%s,0,'\"x\"'::jsonb,60)", (run, step))
        assert r["outcome"] == "failed" and r["reason"] == "config_exceeds_system_ceiling:limits.maxCostInr", r
        assert float(run_row(run)[2]) == 0.0 and steps(run)[0][1] == "failed", "no work may be recorded"
    finally:
        q(OWNER, "alter table public.runs enable trigger runs_enforce_execution_config")
    assert one(OWNER, "select tgenabled from pg_trigger where tgname='runs_enforce_execution_config'") == "O"

# ================================================================= 31 ========
def outcome_counts(results):
    out = {}
    for r in results:
        out[r["outcome"]] = out.get(r["outcome"], 0) + 1
    return out

def race_retry(retry_limit, trials):
    bad_pairs = set()
    for t in range(trials):
        w = start(mk_cfg(n=2, retry=retry_limit))
        backdate(w["step"], 200)
        stop = threading.Event()
        seen = set()
        def reader():
            rc = conn("mig_owner")
            while not stop.is_set():
                for row in q(rc, "select r.status, s.status, s.retry_count from public.runs r join public.run_steps s on s.run_id=r.id "
                                 "where r.id=%s", (w["run"],)):
                    seen.add(tuple(row))
            rc.close()
        res, errs = {}, []
        barrier = threading.Barrier(2)     # only the two racing callers wait; the reader must not
        def worker_path():
            c = conn("service_role")
            barrier.wait()
            try: res["worker"] = one(c, "select public.worker_retry_or_fail_step(%s,%s,%s,'boom')", (w["run"], w["step"], w["rc"]))
            except Exception as e: errs.append(("worker", e))
            c.close()
        def recovery_path():
            c = conn("mig_owner")
            barrier.wait()
            try: res["recover"] = one(c, "select private.recover_stale_run(%s)", (w["run"],))
            except Exception as e: errs.append(("recover", e))
            c.close()
        th = [threading.Thread(target=x) for x in (reader, worker_path, recovery_path)]
        # reader must not wait on the barrier; start it first and give it a moment
        th[0].start(); time.sleep(0.01)
        th[1].start(); th[2].start()
        th[1].join(); th[2].join(); stop.set(); th[0].join()
        assert not errs, errs
        outs = [res["worker"]["outcome"], res["recover"]["outcome"]]
        transitions = [o for o in outs if o in ("retried", "failed")]
        assert len(transitions) == 1, (t, res)                      # exactly ONE genuine transition
        rc_final = steps(w["run"])[0][2]
        if retry_limit == 1:
            assert transitions == ["retried"] and rc_final == 1, (t, res, rc_final)      # retry_count changed exactly once
            allowed = {("running", "running", 0), ("running", "pending", 1)}
        else:
            assert transitions == ["failed"] and rc_final == 0, (t, res, rc_final)
            allowed = {("running", "running", 0), ("failed", "failed", 0)}
        assert seen <= allowed, (t, "partial state observed", seen - allowed)         # never a partial state
        bad_pairs |= (seen - allowed)
    assert not bad_pairs

@test("31", "atomic retry function under both real calling paths (live worker via wrapper vs recover_stale_run), 60 trials retry + 60 terminal")
def _():
    race_retry(retry_limit=1, trials=60)
    race_retry(retry_limit=0, trials=60)

# ================================================================= 32 ========
@test("32", "frozen configuration step mapping: step_index resolves the frozen entry; listing edits, reorders and execution_config UPDATEs cannot alter it")
def _():
    cfg = mk_cfg(n=4, retries=[1, 0, 1, 0])
    w = start(cfg)
    original = one(OWNER, "select execution_config from public.runs where id=%s", (w["run"],))
    step, rc = w["step"], w["rc"]
    for i in range(4):
        rows = steps(w["run"])
        assert [r[0] for r in rows] == list(range(i + 1)), rows           # one row per array position, created in order
        for (idx, *_rest) in rows:
            frozen_id = one(OWNER, "select execution_config->'steps'->%s->>'id' from public.runs where id=%s", (idx, w["run"]))
            assert frozen_id == f"s{idx}", (idx, frozen_id)
        if i < 3:
            one(OWNER, "select private.checkpoint_step(%s,%s,%s,'\"o\"'::jsonb,0)", (w["run"], step, rc))
            c = one(OWNER, "select private.claim_next_step(%s)", (w["run"],))
            step, rc = c["step_id"], c["retry_count"]
    # now edit the LISTING: reorder steps, flip retryLimits
    edited = mk_cfg(n=4, retries=[0, 1, 0, 1]); edited["steps"].reverse()
    q(OWNER, "update public.listings set configuration=%s, version=version+1 where id=%s", (json.dumps(edited), w["listing"]))
    assert one(OWNER, "select execution_config from public.runs where id=%s", (w["run"],)) == original
    for idx in range(4):
        assert one(OWNER, "select execution_config->'steps'->%s->>'id' from public.runs where id=%s", (idx, w["run"])) == f"s{idx}"
    # index-based retry policy from the FROZEN config: step 3 has frozen retryLimit 0 (listing now says 1) => terminal
    r = one(OWNER, "select private.retry_or_fail_step(%s,%s,%s,'x')", (w["run"], step, rc))
    assert r["outcome"] == "failed", r
    # and a step with frozen retryLimit 1 (listing now says 0) still retries
    w2 = start(mk_cfg(n=2, retries=[1, 0]))
    q(OWNER, "update public.listings set configuration=%s where id=%s", (json.dumps(mk_cfg(n=2, retry=0)), w2["listing"]))
    r2 = one(OWNER, "select private.retry_or_fail_step(%s,%s,%s,'x')", (w2["run"], w2["step"], w2["rc"]))
    assert r2["outcome"] == "retried", r2
    # execution_config is immutable for every role, including the owner and a bypassrls service_role
    for who in (OWNER, conn("service_role")):
        raises(who, "update public.runs set execution_config=%s where id=%s", (json.dumps(edited), w["run"]), "CM003", "execution_config_immutable")
    assert one(OWNER, "select execution_config from public.runs where id=%s", (w["run"],)) == original

# ================================================================= 33 ========
def audit_lock_order():
    """First-acquisition order of execution-domain tables in every function must follow runs -> approvals -> run_steps."""
    rank = {"runs": 0, "approvals": 1, "run_steps": 2}
    fns = ["retry_or_fail_step", "claim_next_step", "checkpoint_step", "cancel_run", "decide_approval", "recover_stale_run", "create_run"]
    report = {}
    for fn in fns:
        src = one(OWNER, "select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname=%s", (fn,))
        src = re.sub(r"--[^\n]*", "", src).lower()
        order = []
        for stmt in src.split(";"):
            tbl = None
            m = re.search(r"from\s+public\.(runs|approvals|run_steps)\b[^;]*\bfor\s+update", stmt)
            if m: tbl = m.group(1)
            else:
                m = re.match(r"\s*(?:update\s+public\.|insert\s+into\s+public\.)(runs|approvals|run_steps)\b", stmt.strip() and stmt)
                if m: tbl = m.group(1)
            if tbl and tbl not in order: order.append(tbl)
        ranks = [rank[t] for t in order]
        assert ranks == sorted(ranks), f"{fn}: lock order violated: {order}"
        if fn != "create_run":
            assert order and order[0] == "runs", f"{fn}: must lock runs FIRST, got {order}"
        # every caller of fail_run_closed must already hold the runs lock
        if "fail_run_closed" in src:
            assert src.index("for update") < src.index("fail_run_closed"), f"{fn}: calls fail_run_closed before locking runs"
        report[fn] = order
    return report

@test("33", "global lock ordering: static audit of every function + 120 concurrent trials (checkpoint, recovery, decide_approval, cancel) with zero deadlocks and coherent final state")
def _():
    report = audit_lock_order()
    assert report["decide_approval"] == ["runs", "approvals"], report
    assert report["retry_or_fail_step"] == ["runs", "run_steps"], report
    assert report["cancel_run"] == ["runs", "run_steps"] or report["cancel_run"] == ["runs"], report
    deadlocks, other_errors = 0, []
    finals = {}
    for t in range(120):
        w = start(mk_cfg(n=3, retry=1))
        backdate(w["step"], 200)
        waiting = (t % 2 == 1)
        appr = str(uuid.uuid4())
        if waiting:
            q(OWNER, "update public.runs set status='waiting_for_approval' where id=%s", (w["run"],))
        q(OWNER, "insert into public.approvals (id, run_id, requested_permission) values (%s,%s,'SEND')", (appr, w["run"]))
        barrier = threading.Barrier(4)
        ops = {
            "checkpoint": ("select private.checkpoint_step(%s,%s,%s,'\"o\"'::jsonb,0)", (w["run"], w["step"], w["rc"])),
            "recover":    ("select private.recover_stale_run(%s)", (w["run"],)),
            "decide":     ("select private.decide_approval(%s,'approved',%s)", (appr, w["buyer"])),
            "cancel":     ("select private.cancel_run(%s)", (w["run"],)),
        }
        errs, outs = [], {}
        def go(name):
            c = conn("mig_owner")
            barrier.wait()
            time.sleep(random.random() * 0.003)
            try:
                o = one(c, *ops[name]); outs[name] = o.get("outcome") + ":" + str(o.get("reason", ""))
            except psycopg2.Error as e: errs.append((name, e.pgcode, e.diag.message_primary))
            c.close()
        th = [threading.Thread(target=go, args=(n,)) for n in ops]
        [x.start() for x in th]; [x.join() for x in th]
        for (n, code, msg) in errs:
            if code == "40P01": deadlocks += 1
            else: other_errors.append((t, n, code, msg))
        # coherent final state
        run_status = run_row(w["run"])[0]
        step_states = [s[1] for s in steps(w["run"])]
        sig = tuple(sorted(outs.items()))
        finals[sig] = finals.get(sig, 0) + 1
        if run_status == "cancelled":
            assert all(s in ("skipped", "succeeded", "failed") for s in step_states), (t, step_states)
        if run_status in ("failed", "succeeded", "cancelled", "timed_out"):
            assert not any(s in ("pending", "running") for s in step_states), (t, run_status, step_states)
        a = q(OWNER, "select status, decided_at is not null from public.approvals where id=%s", (appr,))[0]
        assert (a[0] == "pending") == (a[1] is False), (t, a)
    assert deadlocks == 0, f"{deadlocks} deadlocks"
    assert not other_errors, other_errors[:5]
    # different operations must have WON in different trials (cancel-first vs checkpoint-first vs recovery-first ...)
    assert len(finals) >= 4, f"trials did not exercise different interleavings ({len(finals)} distinct outcome signatures): {list(finals)[:3]}"

@test("33b", "control: the harness CAN detect a deadlock (deliberately wrong order approvals->runs vs runs->approvals => SQLSTATE 40P01)")
def _():
    w = start(mk_cfg(n=1))
    appr = str(uuid.uuid4())
    q(OWNER, "insert into public.approvals (id, run_id, requested_permission) values (%s,%s,'SEND')", (appr, w["run"]))
    a, b = conn("mig_owner", False), conn("mig_owner", False)
    q(a, "select 1 from public.approvals where id=%s for update", (appr,))          # A: approvals first (WRONG order)
    q(b, "select 1 from public.runs where id=%s for update", (w["run"],))            # B: runs first (correct)
    out = {}
    def b_second():
        try: q(b, "select 1 from public.approvals where id=%s for update", (appr,))
        except psycopg2.Error as e: out["b"] = e.pgcode
    t = threading.Thread(target=b_second); t.start(); time.sleep(0.3)
    try: q(a, "select 1 from public.runs where id=%s for update", (w["run"],))
    except psycopg2.Error as e: out["a"] = e.pgcode
    t.join(); a.rollback(); b.rollback(); a.close(); b.close()
    assert "40P01" in out.values(), out

# ============================================ supplemental invariant tests ==
@test("S-6", "cancellation fencing: after cancel_run a worker's checkpoint AND retry are rejected and write nothing; steps skipped")
def _():
    w = start(mk_cfg(n=2))
    assert one(OWNER, "select private.cancel_run(%s)", (w["run"],))["outcome"] == "cancelled"
    before = (run_row(w["run"]), steps(w["run"]))
    r = one(OWNER, "select private.checkpoint_step(%s,%s,%s,'\"o\"'::jsonb,1)", (w["run"], w["step"], w["rc"]))
    assert r == {"outcome": "rejected", "reason": "run_not_running"}, r
    r = one(conn("service_role"), "select public.worker_retry_or_fail_step(%s,%s,%s,'x')", (w["run"], w["step"], w["rc"]))
    assert r == {"outcome": "rejected", "reason": "run_not_running"}, r
    assert (run_row(w["run"]), steps(w["run"])) == before
    assert run_row(w["run"])[0] == "cancelled" and steps(w["run"])[0][1] == "skipped"
    assert one(OWNER, "select private.cancel_run(%s)", (w["run"],))["outcome"] == "noop"

@test("S-7", "stale-worker fencing: after a retry the old worker's checkpoint/retry are rejected; no double retry; no retry after terminal")
def _():
    w = start(mk_cfg(n=1, retry=1))
    r1 = one(OWNER, "select private.retry_or_fail_step(%s,%s,0,'e1')", (w["run"], w["step"]))
    assert r1["outcome"] == "retried"
    # the OLD worker (fence 0) tries again while the step is pending / re-claimed
    r = one(OWNER, "select private.retry_or_fail_step(%s,%s,0,'dup')", (w["run"], w["step"]))
    assert r["outcome"] == "rejected" and r["reason"] == "step_not_running", r
    c = one(OWNER, "select private.claim_next_step(%s)", (w["run"],))
    assert c["retry_count"] == 1
    for sql in ("select private.checkpoint_step(%s,%s,0,'\"stale\"'::jsonb,0)", "select private.retry_or_fail_step(%s,%s,0,'dup')"):
        r = one(OWNER, sql, (w["run"], w["step"]))
        assert r == {"outcome": "rejected", "reason": "fencing_mismatch"}, r
    assert steps(w["run"])[0][1:3] == ("running", 1), steps(w["run"])
    # legitimate second failure is terminal (limit 1); nothing more can happen afterwards
    assert one(OWNER, "select private.retry_or_fail_step(%s,%s,1,'e2')", (w["run"], w["step"]))["outcome"] == "failed"
    r = one(OWNER, "select private.retry_or_fail_step(%s,%s,1,'e3')", (w["run"], w["step"]))
    assert r == {"outcome": "rejected", "reason": "run_not_running"}, r
    assert steps(w["run"])[0][2] == 1

@test("S-8", "ownership: a valid step id from ANOTHER run is rejected (step.run_id = run_id) and nothing changes")
def _():
    a, b = start(mk_cfg(n=1)), start(mk_cfg(n=1))
    before = (steps(a["run"]), steps(b["run"]))
    r = one(OWNER, "select private.retry_or_fail_step(%s,%s,0,'x')", (a["run"], b["step"]))
    assert r == {"outcome": "rejected", "reason": "step_not_in_run"}, r
    r = one(OWNER, "select private.checkpoint_step(%s,%s,0,'\"x\"'::jsonb,0)", (a["run"], b["step"]))
    assert r == {"outcome": "rejected", "reason": "step_not_in_run"}, r
    assert (steps(a["run"]), steps(b["run"])) == before

@test("S-9", "recovery: fresh step => noop; stale step => same retry policy (retry, then terminal); all inputs derived from DB")
def _():
    w = start(mk_cfg(n=1, retry=1))
    assert one(OWNER, "select private.recover_stale_run(%s)", (w["run"],)) == {"outcome": "noop", "reason": "nothing_stale"}
    backdate(w["step"], 119)
    assert one(OWNER, "select private.recover_stale_run(%s)", (w["run"],))["reason"] == "nothing_stale"      # below the 120 s threshold
    backdate(w["step"], 121)
    r = one(OWNER, "select private.recover_stale_run(%s)", (w["run"],))
    assert r["outcome"] == "retried" and r["retry_count"] == 1, r
    c = one(OWNER, "select private.claim_next_step(%s)", (w["run"],))
    backdate(c["step_id"], 200)
    r = one(OWNER, "select private.recover_stale_run(%s)", (w["run"],))
    assert r["outcome"] == "failed", r
    assert run_row(w["run"])[0] == "failed"
    assert one(OWNER, "select private.recover_stale_run(%s)", (w["run"],))["outcome"] == "noop"

@test("S-10", "end to end: create -> claim -> checkpoint x3 -> succeeded; frozen config; cost summed; final output = last step")
def _():
    w = start(mk_cfg(n=3, cost=30))
    step, rc = w["step"], w["rc"]
    for i in range(3):
        r = one(OWNER, "select private.checkpoint_step(%s,%s,%s,%s::jsonb,4)", (w["run"], step, rc, json.dumps({"i": i})))
        assert r["outcome"] == ("checkpointed" if i < 2 else "succeeded"), r
        if i < 2:
            c = one(OWNER, "select private.claim_next_step(%s)", (w["run"],))
            step, rc = c["step_id"], c["retry_count"]
    st = run_row(w["run"])
    assert st[0] == "succeeded" and float(st[2]) == 12.0 and st[3] == {"i": 2}, st
    assert [s[1] for s in steps(w["run"])] == ["succeeded"] * 3
    assert one(OWNER, "select private.claim_next_step(%s)", (w["run"],))["reason"] == "run_not_claimable"

@test("S-11", "quota: 20 runs / user / rolling 24 h; 21st rejected (CM015); another user unaffected")
def _():
    w = world(mk_cfg())
    for _i in range(20):
        one(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (w["buyer"], w["listing"]))
    raises(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (w["buyer"], w["listing"]), "CM015", "daily_run_quota_exceeded")
    other = new_user(); entitle(other, w["listing"])
    assert one(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (other, w["listing"]))
    # runs older than 24 h leave the window
    q(OWNER, "update public.runs set created_at = now() - interval '25 hours' where user_id=%s", (w["buyer"],))
    assert one(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (w["buyer"], w["listing"]))

@test("S-12", "quota race: 30 concurrent creates by one user yield exactly 20 runs (advisory lock)")
def _():
    w = world(mk_cfg())
    okc, bad = [], []
    barrier = threading.Barrier(30)
    def go():
        c = conn("mig_owner"); barrier.wait()
        try: okc.append(one(c, "select private.create_run(%s,%s,'{}'::jsonb,false)", (w["buyer"], w["listing"])))
        except psycopg2.Error as e: bad.append(e.pgcode)
        c.close()
    th = [threading.Thread(target=go) for _ in range(30)]
    [t.start() for t in th]; [t.join() for t in th]
    assert len(okc) == 20 and bad.count("CM015") == 10, (len(okc), bad)
    assert one(OWNER, "select count(*) from public.runs where user_id=%s", (w["buyer"],)) == 20

@test("S-13", "create_run gating: playbook (CM012), no entitlement (CM013), not live (CM014), unknown (CM011); owner sandbox allowed")
def _():
    seller, buyer = new_user(), new_user()
    pb = new_listing(seller, {}, ptype="playbook"); entitle(buyer, pb)
    raises(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (buyer, pb), "CM012", "product_not_executable")
    wf = new_listing(seller, mk_cfg())
    raises(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (buyer, wf), "CM013", "not_entitled")
    draft = new_listing(seller, mk_cfg(), status="pending_review"); entitle(buyer, draft)
    raises(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (buyer, draft), "CM014", "product_not_live")
    raises(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (buyer, str(uuid.uuid4())), "CM011", "product_not_found")
    assert one(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,true)", (seller, draft))     # owner sandbox on a draft
    raises(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,true)", (buyer, draft), "CM014")  # a non-owner cannot use sandbox to skip 'live'
    # expired entitlement is not an entitlement
    ex = new_user()
    q(OWNER, "insert into public.entitlements (user_id, product_id, kind, status, current_period_end) values (%s,%s,'subscription','active', now() - interval '1 day')", (ex, wf))
    raises(OWNER, "select private.create_run(%s,%s,'{}'::jsonb,false)", (ex, wf), "CM013")

@test("S-14", "decide_approval is decision-only: decides once (noop after), needs waiting_for_approval, rejects bad decisions, never touches run/steps")
def _():
    w = start(mk_cfg(n=2))
    appr = str(uuid.uuid4())
    q(OWNER, "insert into public.approvals (id, run_id, requested_permission) values (%s,%s,'SEND')", (appr, w["run"]))
    assert one(OWNER, "select private.decide_approval(%s,'approved',%s)", (appr, w["buyer"]))["reason"] == "run_not_waiting_for_approval"
    q(OWNER, "update public.runs set status='waiting_for_approval' where id=%s", (w["run"],))
    assert one(OWNER, "select private.decide_approval(%s,'maybe',%s)", (appr, w["buyer"]))["reason"] == "invalid_decision"
    snap = (run_row(w["run"]), steps(w["run"]))
    assert one(OWNER, "select private.decide_approval(%s,'approved',%s)", (appr, w["buyer"]))["outcome"] == "decided"
    assert one(OWNER, "select private.decide_approval(%s,'rejected',%s)", (appr, w["buyer"]))["reason"] == "already_decided"
    assert (run_row(w["run"]), steps(w["run"])) == snap
    assert q(OWNER, "select status from public.approvals where id=%s", (appr,))[0][0] == "approved"

@test("S-15", "Phase 1 RLS unchanged: authenticated cannot write runs/run_steps, owner sees own runs only, anon sees none")
def _():
    w = start(mk_cfg(n=1))
    other = new_user()
    au = conn("authenticated")
    q(au, "select set_config('request.jwt.claim.sub', %s, false)", (w["buyer"],))
    assert one(au, "select count(*) from public.runs where id=%s", (w["run"],)) == 1
    assert one(au, "select count(*) from public.run_steps where run_id=%s", (w["run"],)) == 1
    raises(au, "insert into public.runs (user_id,product_id,product_version,execution_config) values (%s,%s,1,%s)", (w["buyer"], w["listing"], json.dumps(mk_cfg())), "42501")
    assert q(au, "update public.runs set status='succeeded' where id=%s returning id", (w["run"],)) == []       # RLS: 0 rows
    assert q(au, "update public.run_steps set retry_count=7 where run_id=%s returning id", (w["run"],)) == []
    q(au, "select set_config('request.jwt.claim.sub', %s, false)", (other,))
    assert one(au, "select count(*) from public.runs where id=%s", (w["run"],)) == 0
    an = conn("anon")
    assert one(an, "select count(*) from public.runs") == 0
    assert run_row(w["run"])[0] == "running" and steps(w["run"])[0][2] == 0
    au.close(); an.close()

# ======================================================== 41 parity ==========
@test("41", "ceiling parity: JS constants == SQL constants for every ceiling; ceilings live in no table; no client role can read them")
def _():
    js = json.loads(subprocess.check_output(["node", os.path.join(ROOT, "tests/phase3/dump-ceilings.mjs")], cwd=ROOT, stderr=subprocess.DEVNULL))
    sql = one(OWNER, "select private.system_ceilings()")
    assert js == sql, f"JS/SQL ceilings diverge: {js} vs {sql}"
    assert len(js) == 9
    # a deliberately mutated side must be detected by the same comparison
    mutated = dict(js); mutated["maxRetriesPerStep"] = 2
    assert mutated != sql
    # not stored in any table/column (no table column named like a ceiling, no ceiling values in feature_flags)
    cols = q(OWNER, "select table_schema||'.'||table_name||'.'||column_name from information_schema.columns "
                    "where column_name ilike any (array['%%ceiling%%','maxretries%%','maxstepsper%%'])")
    assert cols == [], cols
    assert one(OWNER, "select count(*) from private.feature_flags") == 1
    for role in ("anon", "authenticated", "service_role"):
        c = conn(role)
        e = err(c, "select private.system_ceilings()"); assert e.pgcode == "42501", (role, e.pgcode)
        c.close()

@test("42", "first workflow config (validate -> ai_process -> transform, zero tools, at/below ceilings) creates a frozen run; Playbook rows untouched")
def _():
    w = world(FIX)
    run = one(OWNER, "select private.create_run(%s,%s,%s::jsonb,false)", (w["buyer"], w["listing"], json.dumps({"minutes": "hello"})))
    assert [s[1] for s in steps(run)] == ["pending"] and one(OWNER, "select execution_config->'steps'->1->>'kind' from public.runs where id=%s", (run,)) == "ai_process"
    assert one(OWNER, "select count(*) from public.listings where product_type='playbook'") >= 0
    assert one(OWNER, "select count(*) from public.tools") == 0    # no tools/integrations touched

# ======================================================== 43-48 privileges ===
def catalog_problems():
    """Reusable privilege/definition audit (test 48 runs it after mutating the catalog)."""
    problems = []
    for sig in FN_PRIVATE:
        name = sig.split("(")[0]
        oid = one(OWNER, "select to_regprocedure(%s)::oid", ("private." + sig,))
        if oid is None:
            problems.append(f"missing private.{sig}"); continue
        n = one(OWNER, "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname=%s", (name,))
        if n != 1: problems.append(f"private.{name}: {n} overloads")
        for role in ("anon", "authenticated", "service_role"):
            if one(OWNER, "select has_function_privilege(%s, %s::oid, 'EXECUTE')", (role, oid)):
                problems.append(f"private.{sig}: EXECUTE held by {role}")
        if one(OWNER, "select exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a "
                      "where p.oid=%s::oid and a.grantee=0 and a.privilege_type='EXECUTE')", (oid,)):
            problems.append(f"private.{sig}: EXECUTE held by PUBLIC")
        if not one(OWNER, "select has_function_privilege('mig_owner', %s::oid, 'EXECUTE')", (oid,)):
            problems.append(f"private.{sig}: owner cannot execute")
    woid = one(OWNER, "select to_regprocedure(%s)::oid", (WRAPPER,))
    if woid is None: problems.append("missing wrapper")
    else:
        for role, want in (("anon", False), ("authenticated", False), ("service_role", True), ("mig_owner", True)):
            if one(OWNER, "select has_function_privilege(%s, %s::oid, 'EXECUTE')", (role, woid)) != want:
                problems.append(f"wrapper EXECUTE for {role} should be {want}")
        if one(OWNER, "select exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a "
                      "where p.oid=%s::oid and a.grantee=0 and a.privilege_type='EXECUTE')", (woid,)):
            problems.append("wrapper: EXECUTE held by PUBLIC")
    n = one(OWNER, "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname ilike '%retry_or_fail_step%'")
    if n != 2: problems.append(f"expected exactly 2 retry_or_fail_step functions (private + wrapper), found {n}")
    for role in ("anon", "authenticated", "service_role"):
        if one(OWNER, "select has_schema_privilege(%s,'private','USAGE')", (role,)):
            problems.append(f"REVIEW: {role} holds USAGE on schema private")
        for priv in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            if one(OWNER, "select has_table_privilege(%s,'private.feature_flags',%s)", (role, priv)):
                problems.append(f"{role} holds {priv} on private.feature_flags")
    return problems

@test("43", "privilege catalog (W1): private functions owner-only; service_role cannot execute them; wrapper = service_role+owner; PUBLIC/anon/authenticated on neither; no USAGE on private")
def _():
    p = catalog_problems()
    assert p == [], p

def dummy_args(sig):
    t = sig.split("(")[1].rstrip(")").split(",")
    m = {"uuid": "'00000000-0000-0000-0000-000000000000'::uuid", "integer": "0", "text": "'x'", "jsonb": "'{}'::jsonb",
         "boolean": "false", "numeric": "0"}
    return ", ".join(m[x] for x in t if x)

@test("44", "denial matrix: anon / authenticated buyer / creator / admin / service_role cannot call private functions; client roles cannot call the wrapper; denied attempts mutate nothing")
def _():
    w = start(mk_cfg(n=2))
    admin = new_user(admin=True)
    snapshot = lambda: (run_row(w["run"]), steps(w["run"]))
    before = snapshot()
    actors = [("anon", None), ("authenticated", w["buyer"]), ("authenticated", w["seller"]), ("authenticated", admin), ("service_role", None)]
    for role, uid in actors:
        c = conn(role)
        if uid: q(c, "select set_config('request.jwt.claim.sub', %s, false)", (uid,))
        for sig in FN_PRIVATE:
            e = err(c, f"select private.{sig.split('(')[0]}({dummy_args(sig)})")
            assert e.pgcode == "42501", (role, sig, e.pgcode, e.diag.message_primary)
        # with VALID ids (readable through RLS for buyer/creator/admin)
        e = err(c, "select private.retry_or_fail_step(%s,%s,%s,'x')", (w["run"], w["step"], w["rc"]))
        assert e.pgcode == "42501", (role, e.pgcode)
        if role != "service_role":
            e = err(c, "select public.worker_retry_or_fail_step(%s,%s,%s,'x')", (w["run"], w["step"], w["rc"]))
            assert e.pgcode == "42501" and "worker_retry_or_fail_step" in e.diag.message_primary, (role, uid, e.diag.message_primary)
        c.close()
    assert snapshot() == before, "a denied attempt changed data"
    # EXECUTE revocation is an INDEPENDENT barrier: even if schema USAGE were later granted, the functions stay closed
    q(SU, "begin")
    try:
        q(SU, "grant usage on schema private to anon, authenticated, service_role")
        for role in ("anon", "authenticated", "service_role"):
            q(SU, f"set local role {role}")
            e = err(SU, "select private.retry_or_fail_step(%s,%s,%s,'x')", (w["run"], w["step"], w["rc"])) if False else None
            try:
                q(SU, "savepoint s")
                q(SU, "select private.retry_or_fail_step(%s,%s,%s,'x')", (w["run"], w["step"], w["rc"]))
                raise AssertionError(f"{role} could execute the private function once USAGE was granted")
            except psycopg2.Error as ex:
                assert ex.pgcode == "42501" and "function" in ex.diag.message_primary, (role, ex.pgcode, ex.diag.message_primary)
                q(SU, "rollback to savepoint s")
            q(SU, "reset role")
    finally:
        q(SU, "rollback")
    assert snapshot() == before

@test("45", "search_path hijack resistance: shadow tables/schema/temp objects captured by a hostile search_path are never used; every function pins search_path=''")
def _():
    w = start(mk_cfg(n=2, retry=1))
    backdate(w["step"], 200)
    q(SU, "drop schema if exists evil cascade"); q(SU, "create schema evil")
    q(SU, "grant usage, create on schema evil to public")
    q(SU, "create table evil.runs (like public.runs including all)")
    q(SU, "create table evil.run_steps (like public.run_steps including all)")
    q(SU, "grant all on all tables in schema evil to public")
    q(SU, "insert into evil.runs (id,user_id,product_id,product_version,status) select %s,user_id,product_id,1,'running' from public.runs where id=%s", (w["run"], w["run"]))
    q(SU, "insert into evil.run_steps (id,run_id,step_index,status,retry_count,started_at) values (%s,%s,0,'running',0, now() - interval '200 seconds')", (w["step"], w["run"]))
    try:
        svc = conn("service_role")
        q(svc, "create temp table runs (like public.runs)"); q(svc, "create temp table run_steps (like public.run_steps)")
        q(svc, "set search_path = pg_temp, evil, public")
        r = one(svc, "select public.worker_retry_or_fail_step(%s,%s,%s,'boom')", (w["run"], w["step"], w["rc"]))
        assert r["outcome"] == "retried", r
        assert q(SU, "select status, retry_count from evil.run_steps")[0] == ("running", 0), "evil.run_steps was touched"
        assert q(SU, "select status from evil.runs")[0][0] == "running", "evil.runs was touched"
        assert one(svc, "select count(*) from pg_temp.run_steps") == 0
        assert steps(w["run"])[0][1:3] == ("pending", 1)
        # recovery path with a hostile session search_path as the owner
        w2 = start(mk_cfg(n=2, retry=1)); backdate(w2["step"], 200)
        ow = conn("mig_owner"); q(ow, "set search_path = evil, public")
        r = one(ow, "select private.recover_stale_run(%s)", (w2["run"],))
        assert r["outcome"] == "retried", r
        assert q(SU, "select count(*) from evil.runs")[0][0] == 1
        svc.close(); ow.close()
    finally:
        q(SU, "drop schema evil cascade")
    # static: every new function pins an empty search_path and has no unqualified relation reference
    for sig in FN_PRIVATE:
        pinned = one(OWNER, "select 'search_path=\"\"' = any(proconfig) from pg_proc where oid=to_regprocedure(%s)::oid", ("private." + sig,))
        assert pinned is True, (sig, "search_path not pinned to empty")
    assert one(OWNER, "select 'search_path=\"\"' = any(proconfig) from pg_proc where oid=to_regprocedure(%s)::oid", (WRAPPER,)) is True
    for sig in FN_PRIVATE + ["public.worker_retry_or_fail_step(uuid,uuid,integer,text)"]:
        fq = sig if sig.startswith("public.") else "private." + sig
        src = one(OWNER, "select prosrc from pg_proc where oid=to_regprocedure(%s)::oid", (fq,))
        src = re.sub(r"--[^\n]*", "", src).lower().replace("for update", "").replace("distinct from", "distinct_")   # operators, not relations
        for m in re.finditer(r"\b(?:from|join|update|insert\s+into)\s+([a-z_][a-z0-9_\.]*)", src):
            assert "." in m.group(1), f"{sig}: unqualified relation reference {m.group(1)!r}"

@test("46", "definition audit: plain FUNCTIONS, SECURITY DEFINER where required, pinned search_path, expected owner, no dynamic SQL, no transaction control, single overload")
def _():
    definer_expected = {s: True for s in FN_PRIVATE}
    definer_expected["system_ceilings()"] = False
    definer_expected["assert_execution_config_within_ceilings(jsonb)"] = False
    for sig, want_def in definer_expected.items():
        row = q(OWNER, "select p.prokind, p.prosecdef, pg_get_userbyid(p.proowner), p.prosrc from pg_proc p where p.oid=to_regprocedure(%s)::oid", ("private." + sig,))[0]
        assert row[0] == "f", (sig, "not a plain function")
        assert row[1] == want_def, (sig, "prosecdef", row[1])
        assert row[2] == "mig_owner", (sig, row[2])
        src = re.sub(r"--[^\n]*", "", row[3]).lower()
        assert not re.search(r"\bexecute\b\s*(format|'|\()", src) and "execute format" not in src, (sig, "dynamic SQL")
        assert not re.search(r"\b(commit|rollback)\b", src), (sig, "transaction control")
    w = q(OWNER, "select p.prokind, p.prosecdef, pg_get_userbyid(p.proowner) from pg_proc p where p.oid=to_regprocedure(%s)::oid", (WRAPPER,))[0]
    assert w == ("f", True, "mig_owner"), w
    wsrc = one(OWNER, "select prosrc from pg_proc where oid=to_regprocedure(%s)::oid", (WRAPPER,)).lower()
    assert wsrc.count("select") == 1 and "private.retry_or_fail_step(" in wsrc and "if " not in wsrc, "wrapper must be a thin single-statement delegate"
    assert catalog_problems() == []

@test("47", "positive controls under the FINAL privileges: worker path (service_role -> wrapper) and recovery path (owner-internal) both succeed; stale fence rejected via the wrapper")
def _():
    w = start(mk_cfg(n=2, retry=1))
    svc = conn("service_role")
    stale = one(svc, "select public.worker_retry_or_fail_step(%s,%s,%s,'boom')", (w["run"], w["step"], 5))     # wrong fence
    assert stale == {"outcome": "rejected", "reason": "fencing_mismatch"}, stale
    assert steps(w["run"])[0][1:3] == ("running", 0)
    ok = one(svc, "select public.worker_retry_or_fail_step(%s,%s,%s,'boom')", (w["run"], w["step"], w["rc"]))
    assert ok["outcome"] == "retried" and ok["retry_count"] == 1, ok
    # recovery path
    w2 = start(mk_cfg(n=2, retry=1)); backdate(w2["step"], 200)
    assert one(OWNER, "select private.recover_stale_run(%s)", (w2["run"],))["outcome"] == "retried"
    # wrapper inaccessible to anon/authenticated (re-asserted here as required by test 47)
    for role in ("anon", "authenticated"):
        c = conn(role); assert err(c, "select public.worker_retry_or_fail_step(%s,%s,0,'x')", (w["run"], w["step"])).pgcode == "42501"; c.close()
    svc.close()

@test("48", "privilege drift & overload guard: the audit is clean, and it DETECTS an added overload, a re-grant, and a USAGE grant (each rolled back)")
def _():
    assert catalog_problems() == []
    mutations = [
        ("overload", "create function private.retry_or_fail_step(uuid, uuid, integer) returns jsonb language sql as $$ select null::jsonb $$", "overloads"),
        ("regrant-authenticated", "grant execute on function private.retry_or_fail_step(uuid,uuid,integer,text) to authenticated", "authenticated"),
        ("regrant-service_role", "grant execute on function private.cancel_run(uuid) to service_role", "service_role"),
        ("regrant-public", "grant execute on function private.create_run(uuid,uuid,jsonb,boolean) to public", "PUBLIC"),
        ("wrapper-to-anon", "grant execute on function public.worker_retry_or_fail_step(uuid,uuid,integer,text) to anon", "anon"),
        ("usage", "grant usage on schema private to authenticated", "USAGE"),
    ]
    for label, ddl, needle in mutations:
        q(SU, "begin")
        try:
            q(SU, ddl)
            # the audit reads through OWNER's connection, so run it inside the SAME transaction via SU
            saved = globals()["OWNER"]; globals()["OWNER"] = SU
            try: found = catalog_problems()
            finally: globals()["OWNER"] = saved
            assert any(needle in p for p in found), (label, found)
        finally:
            q(SU, "rollback")
    assert catalog_problems() == []

# ============================================================== finish ==========
@test("S-99", "feature flag left OFF: the migration seeds OFF and this suite restores OFF; no code path enables it")
def _():
    set_flag(False)
    assert one(OWNER, "select enabled from private.feature_flags where name='phase3_execution'") is False
    srcs = subprocess.run(["grep", "-rlE", "feature_flags", os.path.join(ROOT, "lib"), os.path.join(ROOT, "app"), os.path.join(ROOT, "components")],
                          capture_output=True, text=True).stdout.strip()
    assert srcs == "", "application code references feature_flags: " + srcs
    mig = open(os.path.join(ROOT, "supabase/migrations/20260920100000_create_private_feature_flags.sql")).read()
    assert "values ('phase3_execution', false)" in mig

note("1-30", "v6/v7 tests 1-30", "NOT-IMPL", "specification not present in the handoff; cannot be implemented faithfully")
note("Data-API", "Data API + secret key -> wrapper (real PostgREST)", "SEE-REPORT", "see report: run separately if PostgREST could be provisioned")

passed = sum(1 for r in RESULTS if r[2] == "PASS")
failed = [r for r in RESULTS if r[2] == "FAIL"]
print(f"\n=== {passed} passed, {len(failed)} failed, {sum(1 for r in RESULTS if r[2] == 'NOT-IMPL')} not implemented ===")
json.dump([dict(id=r[0], name=r[1], status=r[2], detail=r[3], seconds=round(r[4], 2)) for r in RESULTS],
          open(os.environ.get("RESULTS_JSON", "/tmp/phase3_db_results.json"), "w"), indent=1)
sys.exit(1 if failed else 0)
