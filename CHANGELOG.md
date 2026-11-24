# aa-bridge plugin changelog

### 0.2.2 (rev. 2026-11-24 01:40-02:46 - in-place revisions, version not bumped)
- Recorded after the fact (2026-11-24): during G0 the canonical copy was edited and synced to the installed copy without a manifest bump, and the
  initialize() reply labelled itself `aa-bridge-v3.6` / `aa-bridge-v3.6.1` (ad-hoc numbering in the commit messages, not a version). Manifest stays 0.2.2.
- `441527c` AA approvals for zcode permissions; offline providers marked disabled in the catalog.
- `fb905b6` permission-mode descriptions match zcode's real policy; pick allow_once.
- `79538a4` approval notices were rejected by AA (400 invalid_notice) and never surfaced - fixed.
- `1024a7e` offer zcode's always-allow on the AA approval card (only when zcode itself provides allow_always).
- `25d90d7` allow_project replied with the whole option object - fixed.
- Version discipline: the manifest is the only version; the handshake string will read from plugin.json and the plugin moves to v0.3 when it
  becomes its own repository (ROADMAP 1.2).

### 0.2.2 (2026-11-23, phase 2)
- modelCatalog: providers/models from zcode provider_config.json (providerOrder x personalModelIds).
- sessionSelect: session/setModel with reasoningLevel fallback ladder, session/setMode.
- Connector: list_model_catalog (live via plugin, static fallback at idle), permission catalog (5 modes), selections persisted to shared file and applied at create+turn; catalog.model/catalog.permission capabilities True.

## 0.2.1 (2026-11-23, rev5 final)
- app-server spawn switched to plain node (process.execPath): NEVER the
  ZCode.app binary. In-bundle-binary processes get LS-registered as a running
  ZCode app (Dock icons + desktop cold-start ghost). See CONTRACT section 5.
- duplicate export async function main() removed (module load crash).

## 0.2.0 (2026-11-22)
- initial bridge plugin: meshcall client/server, AppServer JSONL manager,
  sessionStart/sessionSend/sessionStop/sessionList/sync/shutdown surface,
  rendezvous reconnection, keepalive.
