"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";

const LANDING_STYLES = `
.landing-wrap{ overflow-x:hidden; }
.mono{ font-family:'IBM Plex Mono', monospace; }
.serif{ font-family:'Fraunces', serif; }

.lnav{ position:sticky; top:0; z-index:50; display:flex; align-items:center; justify-content:space-between; padding:20px 6%; background:rgba(237,238,234,0.85); backdrop-filter:blur(8px); border-bottom:1px solid var(--rule); }
.llogo{ font-family:'Fraunces', serif; font-style:italic; font-size:22px; }
.lnav-links{ display:flex; gap:32px; font-size:14px; }
.lnav-cta{ padding:10px 20px; border-radius:6px; background:var(--ink); color:var(--paper-card); font-size:14px; font-weight:500; transition:transform .2s ease; }
.lnav-cta:hover{ transform:translateY(-1px); }
.lnav-auth{ display:flex; align-items:center; gap:10px; }
.lnav-login{ padding:9px 18px; border-radius:6px; border:1.5px solid var(--ink); color:var(--ink); font-size:14px; font-weight:500; transition:background .2s ease; }
.lnav-login:hover{ background:var(--paper-white); }
@media(max-width:760px){ .lnav-links{ display:none; } }

.lhero{ padding:90px 6% 20px; display:grid; grid-template-columns:1fr 1fr; gap:60px; align-items:center; max-width:1200px; margin:0 auto; }
@media(max-width:900px){ .lhero{ grid-template-columns:1fr; padding-top:60px; } }
.leyebrow{ display:inline-block; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); border:1px solid var(--rule); padding:5px 12px; border-radius:100px; margin-bottom:22px; background:var(--paper-white); }
.lh1{ font-family:'Fraunces', serif; font-weight:600; font-size:clamp(34px, 4.4vw, 56px); line-height:1.06; letter-spacing:-0.01em; margin-bottom:22px; }
.lh1 em{ font-style:italic; color:var(--amber-deep); }
.lhero p.lsub{ font-size:17px; line-height:1.55; color:var(--muted); max-width:460px; margin-bottom:32px; }
.lhero-ctas{ display:flex; gap:14px; flex-wrap:wrap; }
.lbtn-primary{ background:var(--amber); color:var(--ink); padding:14px 26px; border-radius:6px; font-weight:600; font-size:15px; display:inline-flex; align-items:center; gap:8px; transition:transform .2s ease, box-shadow .2s ease; box-shadow:0 1px 2px rgba(20,33,61,.1); }
.lbtn-primary:hover{ transform:translateY(-2px); box-shadow:0 6px 16px rgba(226,168,62,.35); }
.lbtn-outline{ border:1.5px solid var(--ink); padding:13px 24px; border-radius:6px; font-weight:500; font-size:15px; transition:background .2s ease; }
.lbtn-outline:hover{ background:var(--paper-white); }

.lthread-card{ background:var(--paper-card); border:1px solid var(--rule); border-radius:10px; padding:22px; position:relative; overflow:hidden; box-shadow:0 10px 30px rgba(20,33,61,.08); }
.lthread-tag{ display:inline-flex; align-items:center; gap:6px; font-size:11px; letter-spacing:.05em; text-transform:uppercase; background:var(--paper-white); border:1px solid var(--rule); padding:4px 10px; border-radius:4px; margin-bottom:16px; }
.lbubble{ font-size:13.5px; padding:10px 14px; border-radius:6px; margin-bottom:10px; max-width:88%; line-height:1.4; opacity:0; transform:translateY(6px); animation:lbubbleIn .5s ease forwards; }
.lbubble.user{ background:var(--paper); border:1px solid #E4E2D8; margin-left:0; }
.lbubble.ai{ background:var(--paper-white); border:1px solid #E4E2D8; margin-left:auto; }
.lbubble.b1{ animation-delay:.3s; } .lbubble.b2{ animation-delay:1.1s; } .lbubble.b3{ animation-delay:1.9s; }
@keyframes lbubbleIn{ to{ opacity:1; transform:translateY(0); } }
.lperforated{ display:flex; align-items:center; gap:10px; margin:18px 0 14px; opacity:0; animation:lbubbleIn .5s ease forwards; animation-delay:2.6s; }
.lperforated .lline{ flex:1; border-top:2px dashed var(--rule); }
.llock-badge{ width:26px; height:26px; border-radius:50%; background:var(--amber); display:flex; align-items:center; justify-content:center; flex-shrink:0; animation:lpulseLock 2.4s ease-in-out infinite; animation-delay:3.2s; }
@keyframes lpulseLock{ 0%,100%{ transform:scale(1); } 50%{ transform:scale(1.12); } }
.llocked-row{ height:14px; border-radius:4px; background:var(--paper); margin-bottom:8px; opacity:0; animation:lbubbleIn .5s ease forwards; }
.llocked-row.l1{ width:70%; animation-delay:2.9s; } .llocked-row.l2{ width:55%; animation-delay:3.1s; } .llocked-row.l3{ width:40%; animation-delay:3.3s; opacity:.5; }
.lprice-tab{ margin-top:16px; display:flex; align-items:center; justify-content:space-between; opacity:0; animation:lbubbleIn .5s ease forwards; animation-delay:3.5s; }
.lprice-tab .lamt{ font-family:'Fraunces', serif; font-weight:600; font-size:20px; }

.lsection{ max-width:1200px; margin:0 auto; padding:90px 6%; }
.lsection-eyebrow{ font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:10px; }
.lsection-title{ font-family:'Fraunces', serif; font-weight:600; font-size:clamp(26px,3vw,38px); margin-bottom:14px; max-width:600px; }
.lsection-sub{ color:var(--muted); font-size:15.5px; max-width:520px; line-height:1.6; margin-bottom:50px; }
.lreveal{ opacity:0; transform:translateY(24px); transition:opacity .7s ease, transform .7s ease; }
.lreveal.lin{ opacity:1; transform:translateY(0); }

.lsteps{ display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--rule); border:1px solid var(--rule); border-radius:10px; overflow:hidden; }
@media(max-width:800px){ .lsteps{ grid-template-columns:1fr; } }
.lstep{ background:var(--paper-card); padding:34px 28px; }
.lstep .lnum{ font-family:'IBM Plex Mono', monospace; color:var(--amber-deep); font-size:13px; margin-bottom:14px; }
.lstep h3{ font-family:'Fraunces', serif; font-weight:600; font-size:19px; margin-bottom:10px; }
.lstep p{ color:var(--muted); font-size:14px; line-height:1.6; }

.lcat-strip{ display:flex; gap:14px; overflow-x:auto; padding-bottom:8px; }
.lcat-pill{ flex:0 0 auto; background:var(--paper-card); border:1px solid var(--rule); border-radius:8px; padding:20px 22px; min-width:180px; transition:transform .2s ease, border-color .2s ease; }
.lcat-pill:hover{ transform:translateY(-3px); border-color:var(--ink); }
.lcat-pill .lcount{ font-family:'IBM Plex Mono', monospace; font-size:12px; color:var(--muted); margin-top:6px; }

.lstats{ display:grid; grid-template-columns:repeat(3,1fr); gap:40px; text-align:center; }
@media(max-width:700px){ .lstats{ grid-template-columns:1fr; gap:32px; } }
.lstat-num{ font-family:'Fraunces', serif; font-weight:700; font-size:clamp(32px,4vw,46px); color:var(--ink); }
.lstat-label{ color:var(--muted); font-size:13.5px; margin-top:6px; }

.lpay-row{ display:flex; flex-wrap:wrap; gap:12px; }
.lpay-chip{ display:flex; align-items:center; gap:8px; background:var(--paper-white); border:1px solid var(--rule); padding:10px 16px; border-radius:100px; font-size:13.5px; }
.lpay-dot{ width:7px; height:7px; border-radius:50%; background:var(--teal); }

.lfooter-cta{ background:var(--ink); color:var(--paper-card); border-radius:16px; margin:0 6% 90px; padding:70px 6%; text-align:center; }
.lfooter-cta h2{ font-family:'Fraunces', serif; font-style:italic; font-weight:500; font-size:clamp(26px,3.6vw,42px); margin-bottom:20px; }
.lfooter-cta p{ color:#B9BEC9; margin-bottom:30px; font-size:15px; }
.lfooter{ text-align:center; padding:30px 6% 60px; color:var(--muted); font-size:13px; }
`;

// Below 1L, showing lakhs would round a real (small, early-stage) number
// down to "₹0.0L+" -- so plain rupees below that threshold, lakhs above it.
// Either way this is the real net-paid-to-sellers figure (gross minus the
// platform fee, same formula as /sell/earnings), not a placeholder.
function formatPayout(netPaidRupees) {
  if (netPaidRupees >= 100000) {
    return { target: netPaidRupees / 100000, decimals: 1, prefix: "₹", suffix: "L+" };
  }
  return { target: netPaidRupees, decimals: 0, prefix: "₹", suffix: "" };
}

export default function LandingClient({ categoryCounts, threadsSold, netPaidRupees, avgRating, reviewCount }) {
  const rootRef = useRef(null);
  const payout = formatPayout(netPaidRupees);

  useEffect(() => {
    const revealEls = rootRef.current.querySelectorAll(".lreveal");
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add("lin")),
      { threshold: 0.15 }
    );
    revealEls.forEach((el) => io.observe(el));

    const counters = rootRef.current.querySelectorAll(".lstat-num");
    const counterIO = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const el = entry.target;
            const target = parseFloat(el.dataset.target);
            const decimals = parseInt(el.dataset.decimals || "0");
            const prefix = el.dataset.prefix || "";
            const suffix = el.dataset.suffix || "";
            const duration = 1400;
            const startTime = performance.now();
            function tick(now) {
              const progress = Math.min((now - startTime) / duration, 1);
              const eased = 1 - Math.pow(1 - progress, 3);
              const value = target * eased;
              const formatted = decimals > 0 ? value.toFixed(decimals) : Math.round(value).toLocaleString("en-IN");
              el.textContent = prefix + formatted + suffix;
              if (progress < 1) requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
            counterIO.unobserve(el);
          }
        });
      },
      { threshold: 0.4 }
    );
    counters.forEach((el) => counterIO.observe(el));

    return () => {
      io.disconnect();
      counterIO.disconnect();
    };
  }, []);

  return (
    <div ref={rootRef} className="landing-wrap">
      <style>{LANDING_STYLES}</style>

      <nav className="lnav">
        <span className="llogo">chatmarket.</span>
        <div className="lnav-links">
          <a href="#how">How it works</a>
          <a href="#categories">Categories</a>
          <a href="#pricing">For sellers</a>
        </div>
        <div className="lnav-auth">
          <Link href="/login" className="lnav-login">Log in</Link>
          <Link href="/signup" className="lnav-cta">Sign up</Link>
        </div>
      </nav>

      <section className="lhero" style={{ paddingBottom: 20 }}>
        <div>
          <span className="leyebrow">For builders tired of the blank prompt</span>
          <h1 className="lh1">Pick up a conversation.<br />Not a <em>blank page.</em></h1>
          <p className="lsub">Chatmarket is where working AI threads — from Claude, ChatGPT, Gemini — change hands. Buy one that's already most of the way there, or sell the one you never finished.</p>
          <div className="lhero-ctas">
            <Link href="/browse" className="lbtn-primary">Browse threads →</Link>
            <Link href="/sell" className="lbtn-outline">Sell a thread</Link>
          </div>
        </div>

        <div className="lthread-card">
          <span className="lthread-tag mono">Claude · Web Development</span>
          <div className="lbubble user b1">Set up subscription tiers with Stripe in Next.js</div>
          <div className="lbubble ai b2">Let's start by installing stripe and configuring webhooks...</div>
          <div className="lbubble user b3">Now add a free trial with a card-required flow</div>

          <div className="lperforated">
            <div className="lline"></div>
            <div className="llock-badge">🔒</div>
            <div className="lline"></div>
          </div>
          <div className="llocked-row l1"></div>
          <div className="llocked-row l2"></div>
          <div className="llocked-row l3"></div>

          <div className="lprice-tab">
            <span className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>42 messages · 80% complete</span>
            <span className="lamt">₹499</span>
          </div>
        </div>
      </section>

      <section id="how" className="lsection">
        <div className="lreveal">
          <div className="lsection-eyebrow">How it works</div>
          <h2 className="lsection-title">Three steps between a stalled chat and someone's head start.</h2>
          <p className="lsection-sub">Whether you're closing out a project or picking one up, the flow is built around one thing: trust that what you're buying actually works.</p>
        </div>

        <div className="lsteps lreveal">
          <div className="lstep">
            <div className="lnum">01</div>
            <h3>List your thread</h3>
            <p>Upload the export, pick a category, set a price. Tell buyers how far you got and what's left.</p>
          </div>
          <div className="lstep">
            <div className="lnum">02</div>
            <h3>We screen it</h3>
            <p>An automated pass clears personal details and credentials before anything goes live — plus a human check early on.</p>
          </div>
          <div className="lstep">
            <div className="lnum">03</div>
            <h3>Buyer unlocks it</h3>
            <p>Payment is held for 48 hours after unlock. It releases to you once the buyer confirms the thread delivers.</p>
          </div>
        </div>
      </section>

      <section id="categories" className="lsection">
        <div className="lreveal">
          <div className="lsection-eyebrow">Browse by category</div>
          <h2 className="lsection-title">Every thread, sorted the way you'd shop for anything else.</h2>
        </div>
        <div className="lcat-strip lreveal">
          {categoryCounts.map((c) => (
            <Link key={c.name} href={`/browse?category=${encodeURIComponent(c.name)}`} className="lcat-pill">
              <div className="serif" style={{ fontWeight: 600 }}>{c.name}</div>
              <div className="lcount">{c.count} {c.count === 1 ? "thread" : "threads"}</div>
            </Link>
          ))}
        </div>
      </section>

      <section className="lsection">
        <div className="lstats lreveal">
          <div>
            <div className="lstat-num" data-target={threadsSold} data-decimals="0">0</div>
            <div className="lstat-label">threads sold</div>
          </div>
          <div>
            <div className="lstat-num" data-target={payout.target} data-decimals={payout.decimals} data-prefix={payout.prefix} data-suffix={payout.suffix}>0</div>
            <div className="lstat-label">paid out to sellers</div>
          </div>
          <div>
            <div className="lstat-num" data-target={avgRating} data-decimals="1">0</div>
            <div className="lstat-label">{reviewCount > 0 ? `average buyer rating (${reviewCount} review${reviewCount === 1 ? "" : "s"})` : "average buyer rating — no reviews yet"}</div>
          </div>
        </div>
      </section>

      <section id="pricing" className="lsection">
        <div className="lreveal">
          <div className="lsection-eyebrow">Checkout</div>
          <h2 className="lsection-title">Pay however you already do.</h2>
          <p className="lsection-sub">Checkout runs on Razorpay, so every unlock supports UPI, netbanking, and cards without you juggling separate integrations.</p>
        </div>
        <div className="lpay-row lreveal">
          <div className="lpay-chip"><span className="lpay-dot"></span>UPI</div>
          <div className="lpay-chip"><span className="lpay-dot"></span>Google Pay</div>
          <div className="lpay-chip"><span className="lpay-dot"></span>Netbanking</div>
          <div className="lpay-chip"><span className="lpay-dot"></span>Credit / Debit Card</div>
          <div className="lpay-chip"><span className="lpay-dot"></span>Razorpay Wallet</div>
        </div>
      </section>

      <div className="lfooter-cta lreveal">
        <h2>Your last chat could be<br />someone else's shortcut.</h2>
        <p>List it in under five minutes. Get paid when it's put to use.</p>
        <Link href="/sell" className="lbtn-primary">Sell your first thread →</Link>
      </div>

      <footer className="lfooter">© 2026 chatmarket. Not affiliated with Anthropic, OpenAI, or Google.</footer>
    </div>
  );
}
