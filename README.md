# DeFi Position Monitor Discord Bot

A lightweight Discord bot that **discovers and monitors DeFi loan and LP positions on-chain**, sending **private Discord DM alerts** when risk thresholds are crossed and providing **slash commands** for at-a-glance status.

The bot is designed to run continuously and act as a **personal early-warning system** for liquidation risk, redemption exposure, and LP range drift.

---

## What This Bot Does

### 🔍 One-Time (or Occasional) Discovery
Before monitoring can begin, the bot scans the blockchain to discover which positions you currently own:

- **Loan NFTs** (e.g. Troves / CDPs)
- **LP position NFTs** (Uniswap v3–style)

Discovery scripts:
- Read wallet addresses from `data/addresses.csv`
- Scan historical `Transfer` logs
- Confirm current ownership on-chain
- Write discovered positions to CSV files
- Track scan progress so future runs are incremental

These scripts **create files if they do not exist**, including:
- Loan / LP position CSVs
- Scan state JSON files used to resume safely

---

### ⏱ Continuous Monitoring (Bot Runtime)

Once discovery is complete, the Discord bot runs continuously:

- Periodically evaluates loan and LP risk using `node-cron`
- Sends **Discord DM alerts** when risk tiers are crossed or escalated
- Provides slash commands for real-time inspection
- Sends a **daily heartbeat DM** summarizing all positions

The bot is intended to run under **pm2** for long-lived operation.

---

## Supported Chains

- Designed with **multi-chain support** in mind
- **Currently tested only on Flare (FLR)**
- Additional chains may work but are untested

---

## Important Setup Notes

### 📌 Initial Scan Block Selection (Important)

For best performance and correctness:

- **Manually check the blockchain** for:
  - Your earliest *active* loan position
  - Your earliest *active* LP position
- Choose a block number **just before** those positions were created
- Set that block in `.env` (per protocol) for the initial scan

This avoids unnecessary full-chain scans while ensuring no active positions are missed.

---

### 📁 Files Created Automatically

If missing, the following are created automatically:

- Loan position CSVs (per protocol)
- LP position CSVs (per protocol)
- Scan state files:
  - `loan_scan_state.json`
  - `lp_scan_state.json`

These files are safe to inspect and back up.

---

### 📊 Global Interest Rate Configuration (Loans)

Some protocols (e.g. Enosys) **do not expose a global reference interest rate on-chain**.

As a result:
- The bot **cannot fetch the global IR automatically**
- You must:
  - Check the current global rate on the **Enosys dashboard**
  - Manually update it in `.env`

This value is used to assess **redemption priority risk**.

---

## Alerts & Notifications

- Alerts are sent as **Discord DMs**
- Alerts are **deduplicated**:
  - Only fire when a condition becomes active or escalates
- Alert types include:
  - Loan liquidation risk
  - Loan redemption priority
  - LP out-of-range severity

⚠️ **Current limitation:**  
The bot is designed to DM **one user only** (your own Discord ID).

---

## Discord Commands

### `/my-loans`
Shows all monitored loan positions:
- LTV and liquidation buffer
- Interest rate vs global reference
- Redemption and liquidation risk tiers

### `/my-lp`
Shows all monitored LP positions:
- In-range / out-of-range status
- Severity tier
- Current tick vs position bounds

---

## Running the Bot

Typical production setup:

```bash
pm2 start index.js --name defi-position-monitor
pm2 save
pm2 startup
```

Discovery scripts can be rerun at any time to pick up **new positions**.

---

## Roadmap

- Migrate from CSV files to a **database backend**
- Support **multiple users**
- Self-registration and wallet linking
- Per-user alert configuration
- Expanded multi-chain support

---

## Summary

- Discovery scripts find what you own, directly from the blockchain
- The bot continuously monitors risk with minimal noise
- Alerts are private, actionable, and tier-aware
- Designed as a personal DeFi safety monitor today
- Built to evolve into a multi-user system tomorrow
