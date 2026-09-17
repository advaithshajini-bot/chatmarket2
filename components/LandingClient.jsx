"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import SocialBar from "@/components/SocialBar";
import ProductCard from "@/components/ProductCard";
import { PRODUCT_TYPE_ORDER, productTypeMeta } from "@/lib/product-types";

const EXAMPLE_PROMPTS = [
  "Qualify my WhatsApp leads",
  "Create 30 days of social content",
  "Summarize contracts",
  "Screen applicants",
  "Generate product listings",
];

const LANDING_STYLES = `
.landing-wrap{ overflow-x:hidden; }
.mono{ font-family:'IBM Plex Mono', monospace; }
.serif{ font-family:'Fraunces', serif; }

.lnav{ position:sticky; top:0; z-index:50; display:flex; align-items:center; justify-content:space-between; padding:20px 6%; background:rgba(237,238,234,0.85); backdrop-filter:blur(8px); border-bottom:1px solid var(--rule); }
.llogo{ font-family:'Fraunces', serif; font-style:italic; font-size:22px; }
.lnav-links{ display:flex; gap:32px; font-size:14px; align-items:center; }
.lnav-cat{ position:relative; cursor:default; }
.lnav-cat-dropdown{
  position:absolute; top:100%; left:50%; transform:translateX(-50%) translateY(4px);
  background:var(--paper-white); border:1px solid var(--rule); border-radius:10px;
  padding:8px; min-width:230px; max-height:360px; overflow-y:auto;
  box-shadow:0 14px 32px rgba(20,33,61,0.14);
  opacity:0; visibility:hidden; pointer-events:none;
  transition:opacity .15s ease, transform .15s ease;
  display:grid; gap:2px; z-index:60;
}
.lnav-cat:hover .lnav-cat-dropdown, .lnav-cat:focus-within .lnav-cat-dropdown{
  opacity:1; visibility:visible; pointer-events:auto; transform:translateX(-50%) translateY(0);
}
.lnav-cat-item{ display:flex; align-items:center; justify-content:space-between; gap:16px; padding:8px 10px; border-radius:6px; font-size:13px; color:var(--ink); }
.lnav-cat-item:hover{ background:var(--paper); }
.lnav-cat-count{ font-size:11px; color:var(--muted); font-family:'IBM Plex Mono', monospace; }
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
.lprompt-row{ display:flex; flex-wrap:wrap; gap:8px; margin-bottom:28px; }
.lprompt-chip{ font-size:12.5px; padding:7px 13px; border-radius:100px; border:1px dashed var(--rule); color:var(--muted); background:var(--paper-white); transition:border-color .15s ease, color .15s ease; }
.lprompt-chip:hover{ border-color:var(--ink); color:var(--ink); }

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
.ltype-step{ background:var(--paper-card); padding:34px 28px; }
.ltype-step .ltype-icon{ display:inline-flex; align-items:center; justify-content:center; width:38px; height:38px; border-radius:8px; margin-bottom:16px; }
.ltype-step h3{ font-family:'Fraunces', serif; font-weight:600; font-size:19px; margin-bottom:6px; }
.ltype-step .lverb{ font-family:'IBM Plex Mono', monospace; font-size:11px; text-transform:uppercase; letter-spacing:.06em; margin-bottom:10px; display:block; }
.ltype-step p{ color:var(--muted); font-size:14px; line-height:1.6; margin-bottom:14px; }
.ltype-step a.llink{ font-size:13px; font-weight:500; }

.lcat-strip{ display:flex; gap:14px; overflow-x:auto; padding-bottom:8px; }
.lcat-pill{ flex:0 0 auto; background:var(--paper-card); border:1px solid var(--rule); border-radius:8px; padding:20px 22px; min-width:180px; transition:transform .2s ease, border-color .2s ease; }
.lcat-pill:hover{ transform:translateY(-3px); border-color:var(--ink); }

.lproduct-grid{ display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
@media(max-width:900px){ .lproduct-grid{ grid-template-columns:repeat(2,1fr); } }
@media(max-width:640px){ .lproduct-grid{ grid-template-columns:1fr; } }

.lpay-row{ display:flex; flex-wrap:wrap; gap:12px; }
.lpay-chip{ display:flex; align-items:center; gap:8px; background:var(--paper-white); border:1px solid var(--rule); padding:10px 16px; border-radius:100px; font-size:13.5px; }
.lpay-dot{ width:7px; height:7px; border-radius:50%; background:var(--teal); }

.lfooter-cta{ background:var(--ink); color:var(--paper-card); border-radius:16px; margin:0 6% 90px; padding:70px 6%; text-align:center; }
.lfooter-cta h2{ font-family:'Fraunces', serif; font-style:italic; font-weight:500; font-size:clamp(26px,3.6vw,42px); margin-bottom:20px; }
.lfooter-cta p{ color:#B9BEC9; margin-bottom:30px; font-size:15px; }
`;

export default function LandingClient({ categoryCounts, featuredProducts = [], popularProducts = [], newProducts = [] }) {
  const rootRef = useRef(null);
  const router = useRouter();
  const [user, setUser] = useState(undefined); // undefined = loading, null = logged out

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setUser(data.user || null));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user || null));
    return () => listener.subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
    router.refresh();
  };

  useEffect(() => {
    const revealEls = rootRef.current.querySelectorAll(".lreveal");
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add("lin")),
      { threshold: 0.15 }
    );
    revealEls.forEach((el) => io.observe(el));

    return () => {
      io.disconnect();
    };
  }, []);

  const runSearch = (q) => {
    router.push(q ? `/browse?q=${encodeURIComponent(q)}` : "/browse");
  };

  return (
    <div ref={rootRef} className="landing-wrap">
      <style>{LANDING_STYLES}</style>

      <div className="flex items-center justify-end px-6 py-2" style={{ borderBottom: "1px solid #E4E2D8" }}>
        <SocialBar />
      </div>

      <nav className="lnav">
        <span className="llogo">chatmarket.</span>
        <div className="lnav-links">
          <Link href="/browse">Explore</Link>
          <div className="lnav-cat" tabIndex={0}>
            <span>Categories</span>
            <div className="lnav-cat-dropdown">
              {categoryCounts.map((c) => (
                <Link key={c.name} href={`/browse?category=${encodeURIComponent(c.name)}`} className="lnav-cat-item">
                  <span className="serif" style={{ fontWeight: 500 }}>{c.name}</span>
                  <span className="lnav-cat-count">{c.count}</span>
                </Link>
              ))}
            </div>
          </div>
          <Link href="/how-it-works">How it works</Link>
          <Link href="/for-sellers">Sell</Link>
        </div>
        <div className="lnav-auth">
          {user === undefined ? null : user ? (
            <button onClick={handleLogout} className="lnav-login" style={{ cursor: "pointer" }}>Log out</button>
          ) : (
            <>
              <Link href="/login" className="lnav-login">Log in</Link>
              <Link href="/signup" className="lnav-cta">Sign up</Link>
            </>
          )}
        </div>
      </nav>

      <section className="lhero" style={{ paddingBottom: 20 }}>
        <div>
          <span className="leyebrow">Playbooks · Workflows · Agents</span>
          <h1 className="lh1">AI workers for<br />real <em>business work.</em></h1>
          <p className="lsub">Discover Playbooks, Workflows, and Agents that do specific jobs — reusable knowledge to learn from, automations that run themselves, and AI workers you can delegate to.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(e.target.elements.heroSearch.value.trim());
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-full mb-4"
            style={{ background: "#FFFFFF", border: "1px solid #D8D5C9", maxWidth: 460 }}
          >
            <Search size={14} color="#6B6F76" />
            <input
              name="heroSearch"
              placeholder="What do you want to get done?"
              aria-label="What do you want to get done?"
              className="text-sm bg-transparent outline-none w-full"
              style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}
            />
          </form>
          <div className="lprompt-row">
            {EXAMPLE_PROMPTS.map((prompt) => (
              <button key={prompt} type="button" className="lprompt-chip" onClick={() => runSearch(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
          <div className="lhero-ctas">
            <Link href="/browse" className="lbtn-primary">Browse products →</Link>
            <Link href="/sell" className="lbtn-outline">Become a creator</Link>
          </div>
        </div>

        <div className="lthread-card">
          <span className="lthread-tag mono">Workflow · Sales</span>
          <div className="lbubble user b1">Input: New WhatsApp lead arrives</div>
          <div className="lbubble ai b2">Step: Qualify intent &amp; score fit</div>
          <div className="lbubble user b3">Output: Hot leads routed to sales</div>

          <div className="lperforated">
            <div className="lline"></div>
            <div className="llock-badge">🔒</div>
            <div className="lline"></div>
          </div>
          <div className="llocked-row l1"></div>
          <div className="llocked-row l2"></div>
          <div className="llocked-row l3"></div>

          <div className="lprice-tab" style={{ justifyContent: "flex-end" }}>
            <span className="lamt">₹499</span>
          </div>
        </div>
      </section>

      <section id="categories" className="lsection">
        <div className="lreveal">
          <div className="lsection-eyebrow">Browse by category</div>
          <h2 className="lsection-title">Every product, sorted the way you'd shop for anything else.</h2>
        </div>
        <div className="lcat-strip lreveal">
          {categoryCounts.filter((c) => c.count > 0).map((c) => (
            <Link key={c.name} href={`/browse?category=${encodeURIComponent(c.name)}`} className="lcat-pill">
              <div className="serif" style={{ fontWeight: 600 }}>{c.name}</div>
            </Link>
          ))}
          <Link
            href="/browse"
            className="flex-shrink-0 flex items-center justify-center"
            style={{
              flex: "0 0 auto",
              borderRadius: 999,
              padding: "0 26px",
              minWidth: 140,
              border: "1px solid #14213D",
              color: "#14213D",
              fontFamily: "'IBM Plex Sans', sans-serif",
              fontWeight: 500,
              fontSize: 14,
            }}
          >
            See all →
          </Link>
        </div>
      </section>

      {featuredProducts.length > 0 && (
        <section className="lsection" style={{ paddingTop: 0 }}>
          <div className="lreveal">
            <div className="lsection-eyebrow">Featured</div>
            <h2 className="lsection-title">Start with a few of the best on chatmarket.</h2>
          </div>
          <div className="lproduct-grid lreveal">
            {featuredProducts.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      )}

      <section className="lsection">
        <div className="lreveal">
          <div className="lsection-eyebrow">Three ways to put AI to work</div>
          <h2 className="lsection-title">Playbooks, Workflows, and Agents aren't the same kind of product.</h2>
          <p className="lsection-sub">Each one asks something different of you — from reading a guide, to configuring a repeatable process, to handing off a job entirely.</p>
        </div>

        <div className="lsteps lreveal">
          {PRODUCT_TYPE_ORDER.map((type) => {
            const meta = productTypeMeta(type);
            const Icon = meta.icon;
            return (
              <div key={type} className="ltype-step">
                <div className="ltype-icon" style={{ background: `color-mix(in srgb, var(${meta.colorVar}) 14%, transparent)` }}>
                  <Icon size={19} color={`var(${meta.colorVar})`} strokeWidth={2.25} />
                </div>
                <span className="lverb" style={{ color: `var(${meta.colorVar})` }}>{meta.verb}</span>
                <h3>{meta.label}</h3>
                <p>{meta.description}</p>
                <Link href={`/browse?type=${type}`} className="llink" style={{ color: "#14213D" }}>
                  Browse {meta.label.toLowerCase()}s →
                </Link>
              </div>
            );
          })}
        </div>
      </section>

      {popularProducts.length > 0 && (
        <section className="lsection">
          <div className="lreveal">
            <div className="lsection-eyebrow">Popular</div>
            <h2 className="lsection-title">What people are unlocking most.</h2>
          </div>
          <div className="lproduct-grid lreveal">
            {popularProducts.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      )}

      {newProducts.length > 0 && (
        <section className="lsection">
          <div className="lreveal">
            <div className="lsection-eyebrow">New</div>
            <h2 className="lsection-title">Just added to the marketplace.</h2>
          </div>
          <div className="lproduct-grid lreveal">
            {newProducts.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      )}

      <section className="lsection">
        <div className="lreveal">
          <div className="lsection-eyebrow">How it works — for sellers</div>
          <h2 className="lsection-title">You already did the work. Here's how to get paid for it.</h2>
          <p className="lsection-sub">If you've never sold on chatmarket before, here's exactly what's involved — from what you need to how and when the money actually reaches you.</p>
        </div>

        <div className="lsteps lreveal">
          <div className="lstep">
            <div className="lnum">01</div>
            <h3>Pick a product type</h3>
            <p>A Playbook (an exported conversation and whatever it produced), a Workflow, or an Agent — each has its own quick setup, but they all start from the same "List a product" button.</p>
          </div>
          <div className="lstep">
            <div className="lnum">02</div>
            <h3>Verify your identity — once</h3>
            <p>Before you can list anything, you'll complete a one-time identity check: your name, PAN, and address, so we know who to pay. An admin reviews it, usually quickly. You can't publish until this is approved — it's what makes payouts possible in the first place.</p>
          </div>
          <div className="lstep">
            <div className="lnum">03</div>
            <h3>List it, get approved, get paid</h3>
            <p>Fill in the details, pick a category and price, and tell buyers what it covers. An admin briefly reviews the listing too, then it goes live. When someone buys it, that payment is held for 48 hours (in case of a dispute), then released to your account.</p>
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
        <h2>Built something useful with AI?<br />Put it to work for someone else.</h2>
        <p>List a Playbook, Workflow, or Agent in minutes. Get paid when it's put to use.</p>
        <Link href="/sell" className="lbtn-primary">List your first product →</Link>
      </div>
    </div>
  );
}
