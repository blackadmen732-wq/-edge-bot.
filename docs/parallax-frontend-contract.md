# PARALLAX frontend contract for Claude

Canonical source: dashboard/desk/index.html and imported ES modules. desktop.html is a generated standalone build, not a separately edited product. Preserve existing research endpoints and paper desk.

New frontend integration: GET {configured HTTPS base}/v1/universe, Authorization: Bearer token. Token held in memory only. Backend must authorize every request and scope all records to the authenticated owner; UI filtering is not access control. CORS must allow the chosen frontend origin.

Response: {records: [{id: string, name: string, kind: source|dataset|pattern|experiment, market: string, status: string, updatedAt: ISO timestamp, description?: string, relatedIds?: string[], provenance?: {source: string, version: string, observedAt: ISO timestamp, url?: HTTPS URL}, evidence?: object}]}. Unique ids, maximum 5000 records; graph draws first 60 filtered records, list/export includes all received matches. Production pagination and large dataset exports require a separate backend contract before exceeding that limit.

Relationships represent backend-supplied links, never automatically inferred causation. Pattern status must distinguish hypotheses from validated findings. Evidence should include method, sample size, date window, dataset version, results, uncertainty and out-of-sample performance. Unknown values remain unknown.

UI: search, market/type filters, sort, keyboard-selectable graph nodes, evidence inspector, provenance links, filtered JSON export, disconnected/loading/error/empty/example states. Example mode is explicit and labelled in the UI and exported file. No public marketplace.

Existing backend: authenticated edge-research API, MCP, research chat. Existing local paper simulator persists only to browser storage; not a real financial ledger. Agent roles do not independently execute trades.

Claude owns backend ingestion, scalable search/download, source permissions, pattern workers, model validation and real event streaming. This frontend does not fabricate those services.
