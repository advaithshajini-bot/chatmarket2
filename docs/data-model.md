> **DEPRECATED / HISTORICAL.** This document is an early planning draft
> (references Stripe, `password_hash`, and an escrow `transactions` table) that
> was never implemented and conflicts with the real, live schema. Do not use it
> as a reference. The authoritative schema is `docs/supabase-schema.sql`; the
> Chatmarket 2.0 product/permission model built on top of it is documented in
> `docs/product-domain-model.md`. Kept here only for historical context on the
> original category-taxonomy thinking.

# ChatMarket — Data Model & Category Taxonomy

## 1. Category Taxonomy (Amazon-style departments)

Top-level categories, each with sub-categories for filtering:

- **Web Development**
  - Frontend builds, Backend/API, Full-stack apps, Bug fixes/debugging, DevOps/deployment
- **Software & Automation**
  - Scripts & tools, Data pipelines, Browser extensions, Mobile apps
- **Data & Analytics**
  - Data cleaning, Visualization, Statistical analysis, ML/model building
- **Writing & Content**
  - Blog posts, Marketing copy, Technical documentation, Fiction/creative
- **Business & Strategy**
  - Business plans, Market research, Pitch decks, Financial modeling
- **Design**
  - UI/UX flows, Branding, Prompt-to-image workflows
- **Education & Research**
  - Study guides, Literature reviews, Tutoring sessions

Each listing also tags: **source model** (Claude / ChatGPT / Gemini / other), **message count**, **est. completion %** (e.g. "80% done, needs final deploy step"), **language/framework** (for code).

---

## 2. Core Database Schema (PostgreSQL)

```sql
-- Users (buyers and sellers are the same table, role-flagged)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    stripe_account_id TEXT,          -- Stripe Connect account (for sellers)
    is_seller_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Categories (self-referencing for sub-categories)
CREATE TABLE categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id INT REFERENCES categories(id)
);

-- Listings = the "product" (the chat history)
CREATE TABLE listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id UUID REFERENCES users(id) NOT NULL,
    category_id INT REFERENCES categories(id) NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    source_model TEXT NOT NULL,       -- 'claude', 'chatgpt', 'gemini', etc.
    message_count INT,
    completion_pct INT,               -- seller's self-reported progress
    price_cents INT NOT NULL,
    preview_text TEXT,                -- first N messages, shown publicly
    status TEXT DEFAULT 'pending_review',
        -- pending_review | live | flagged | removed
    redaction_passed BOOLEAN DEFAULT FALSE,
    storage_key TEXT NOT NULL,        -- pointer to encrypted file in S3
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Redaction / moderation log
CREATE TABLE redaction_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID REFERENCES listings(id),
    flag_type TEXT,                   -- 'email', 'phone', 'api_key', 'address', etc.
    snippet_context TEXT,             -- masked context for human reviewer
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Transactions (escrow-aware)
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID REFERENCES listings(id) NOT NULL,
    buyer_id UUID REFERENCES users(id) NOT NULL,
    seller_id UUID REFERENCES users(id) NOT NULL,
    amount_cents INT NOT NULL,
    platform_fee_cents INT NOT NULL,  -- your commission
    stripe_payment_intent_id TEXT,
    status TEXT DEFAULT 'held',
        -- held | released | refunded | disputed
    unlocked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Reviews
CREATE TABLE reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID REFERENCES transactions(id) NOT NULL,
    rating INT CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Disputes
CREATE TABLE disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID REFERENCES transactions(id) NOT NULL,
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'open',       -- open | resolved_buyer | resolved_seller
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for search/filter performance
CREATE INDEX idx_listings_category ON listings(category_id);
CREATE INDEX idx_listings_status ON listings(status);
CREATE INDEX idx_listings_source_model ON listings(source_model);
CREATE INDEX idx_listings_search ON listings USING GIN (to_tsvector('english', title || ' ' || description));
```

---

## 3. Key Flow Notes

**Listing lifecycle:**
`pending_review` → automated redaction scan → human spot-check (early on, review everything manually) → `live`

**Purchase lifecycle:**
1. Buyer pays → Stripe PaymentIntent created, funds held (`status: held`)
2. Buyer gets decrypted access to `storage_key` content (`unlocked_at` set)
3. After a confirmation window (e.g. 48–72 hrs) with no dispute, funds auto-release to seller minus `platform_fee_cents`
4. If disputed, funds stay held until you resolve it manually

**Commission:** calculate `platform_fee_cents` as a percentage of `amount_cents` (e.g. 18%) at checkout time, so Stripe Connect can split the transfer automatically using [destination charges](https://docs.stripe.com/connect/destination-charges).

**Redaction scan:** run before `status` can move to `live` — regex pass for emails/phones/keys, plus an LLM pass (e.g. a Claude API call) that reads the transcript and flags anything that looks like PII, credentials, or proprietary business detail, returning structured JSON flags into `redaction_flags`.

---

## 4. Suggested Build Order

1. `users`, `categories`, `listings` tables + basic CRUD — get listings creatable and browsable
2. Search/filter UI on top of the GIN index + category tree
3. Stripe Connect onboarding for sellers (`stripe_account_id`)
4. Checkout flow → `transactions` table → held funds
5. Unlock mechanism (decrypt `storage_key` content for buyer only post-payment)
6. Redaction pipeline (regex + LLM pass) gating `pending_review` → `live`
7. Reviews + disputes once you have real transaction volume
