# Comfort Secure Wallet — MVP

A licensed-grade, mobile-first installable PWA digital wallet designed for Zimbabwe and wider Africa (`USD` default, multi-currency architecture with `ZWG` and `ZAR` support, double-entry ledger, PIN step-up security, KYC onboarding, and Maker-Checker operations).

---

## Architecture Overview

```
Client (Mobile-First PWA on Cloudflare Pages + Back-Office Console)
   │  HTTPS / CSP / HSTS / CSRF + Bearer Access Token + httpOnly Refresh Cookie
   ▼
Express Modular Monolith (/api/v1 + OpenAPI /api/v1/docs)
   ├── Auth Module         (Argon2id passwords, Google Firebase OAuth, 6-Digit PIN Quick Sign-In, 6-digit OTP, Refresh Reuse Detection)
   ├── PIN Module          (Argon2id + server pepper, 3-attempt 30m lockout, View, Transaction & Admin Action Step-Up Tokens)
   ├── KYC & Vault Module  (AES-256-GCM National IDs, Signed 60s Document URLs, KYC Officer Approval Queue)
   ├── Accounts Module     (Random 10-digit Luhn Account Numbers, Multi-Currency Wallets)
   ├── Ledger Module       (Immutable journal_entries & journal_lines, Debits == Credits, Ordered Locks, Reversals)
   ├── Transactions Module (Idempotent P2P Transfers, Duplicate-Ref Deposits, Hold-Ledger Withdrawals)
   ├── Rules & DB RBAC     (Database-populated RBAC Matrix, Super Admin Bootstrap, Dual Control, Daily/Monthly Limits)
   ├── Statements Module   (Opening/Closing Balances, Background CSV & PDF Exports, PDF Receipts)
   ├── Notifications       (Enforced Transaction Web Push + In-App, Async Retry Queue, Africa's Talking SMS Adapter)
   ├── Risk & Compliance   (Velocity, Structuring, New-Device, Repeated PIN Lockout Flags)
   └── Admin & Recon       (Least-Privilege 7-Role RBAC, Daily Settlement Reconciliation, Append-Only Audit Logs)
```

---

## GitHub & Cloudflare Pages Deployment Guide

1. **Push to GitHub**:
   - Initialize/link your GitHub remote and push (`git push origin main`). `.gitignore` excludes `.env`, `node_modules`, and `dist`.
2. **Connect to Cloudflare Pages**:
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - Included files: `wrangler.toml`, `public/_headers`, and `functions/api/[[path]].ts` (forwards `/api/*` requests to your backend `API_ORIGIN`).
3. **Configure Secrets in Cloudflare Dashboard** (*Settings -> Variables and Secrets*):
   - `WALLET_JWT_SECRET` (64+ char random hex)
   - `WALLET_REFRESH_SECRET` (64+ char random hex)
   - `WALLET_PIN_PEPPER` (64+ char random hex)
   - `WALLET_FIELD_ENCRYPTION_KEY` (32-byte key)
   - `WALLET_SIGNED_URL_SECRET` (32+ char hex)
   - `SUPER_ADMIN_EMAIL` (defaults to `comfort.designszw@gmail.com`)
   - `API_ORIGIN` (HTTPS URL of your running backend service, e.g. `https://api.comfortwallet.zw`)
   - `NODE_ENV=production` (on backend runtime so sandbox seed users are strictly disabled)

> In **Production** (`NODE_ENV=production`), seeded demo/staff accounts are **automatically disabled**. Staff sign up via Google Social Sign-In, Email+Password, or Phone+Password on the Back-Office Console; `comfort.designszw@gmail.com` automatically receives `SUPER_ADMIN` privileges and approves/promotes other staff (`FINANCE_MAKER`, `FINANCE_CHECKER`, `KYC_OFFICER`, `COMPLIANCE_OFFICER`, `SUPPORT_AGENT`, `AUDITOR`).

---

## Local Setup & Commands

```bash
npm install
npm run dev      # Starts Express + Vite PWA on http://localhost:3000
npm test         # Runs Vitest unit, property, and integration tests
npm run lint     # TypeScript strict typecheck
npm run build    # Production Vite PWA bundle into dist/
```

---

© 2026 Comfort Secure Wallet. All Rights Reserved. Developed with ❤️ by Comfort Designs - +263772824132.
