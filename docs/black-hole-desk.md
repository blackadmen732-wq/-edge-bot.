# Black Hole desk

Open dashboard/desk/desktop.html directly, or serve the repository with python -m http.server 8000 and visit /dashboard/desk/. The embedded research workspace uses the existing deployed API and requires its research token.

Implemented: responsive orbital overview, six role event panels, decision evidence drawer, paper accounting, candidate JSON import, manual timestamped quote updates, JSON export, connection directory and existing research workspace.

Paper bankroll defaults to a simulated $1,000. Stop and trail percentages must be entered. The 1% per-side cost is an explicit assumption. A score is imported, not trained or independently validated. All screening assertions are imported, not verified on-chain. No evidence means rejection. Session data is held in memory; export before closing. Candidate mints are evaluated once per session.

Not implemented: autonomous launch discovery, protocol decoders, provider-verified wallet history, model training, live execution, background monitoring, durable desk sessions, automatic quote ingestion, notifications, or Grabbot adapter. No wallet keys are requested. The research MCP endpoint does not expose desk simulator tools.

Tests: node --test tests/desk.test.mjs. JavaScript syntax: node --check dashboard/desk/app.mjs. Browser visual verification has not yet been performed.
