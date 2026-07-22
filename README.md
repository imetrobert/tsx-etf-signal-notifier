# TSX ETF Signal Notifier

Notification-only buy/sell signal tracker for TSX ETFs, optimized for a 5-year
hold horizon. Tracks holdings with live values, evaluates daily rules-based
signals (50/200-day MA crossovers + stretch vs 200-day MA), and emails
high-confidence alerts with reasoning and an estimated recovery timeframe.

**This tool never places trades.** It is strictly informational.

Live site: https://imetrobert.github.io/tsx-etf-signal-notifier/

Built with React + Vite, Supabase (shared auth with the AI with Robert
invoicing app), GitHub Actions (daily signal cron), EmailJS, GitHub Pages.

Full setup and structure documentation will be completed as build stages land.
