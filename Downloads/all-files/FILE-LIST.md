# File List

## Main Deliverable (recommended)

- **doc-tool-multi-template.html** — Final version. Four templates (Employment Certificate / Approval Form / Announcement / Free Layout) + trilingual switching (Simplified/Traditional Chinese, English) + full validation. Zero-dependency, runs fully offline. **Use this for daily work.**

## README (trilingual)

- **README-zh-Hans.md** — Simplified Chinese
- **README-zh-Hant.md** — Traditional Chinese
- **README-English.md** — English

## Legacy Versions (kept for reference)

- **employment-cert-tool-offline.html** — Predecessor of the multi-template version; single employment-certificate tool, fully featured.
- **doc-editor-freeform.html** — Generic modular editor (now merged into the multi-template version's "Free Layout").
- **employment-cert-tool-cdn.html** — Early version (depends on CDN, requires internet).
- **docx-find-replace.html** — The original Word find-and-replace tool.
- **employment-cert-dev-log.md** — Full development log of the employment-certificate tool.

## Backend with Login (optional, requires server deployment)

- **cert-app/** — FastAPI + JWT login backend (kept separately, not merged into the main tool).
