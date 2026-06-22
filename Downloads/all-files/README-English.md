# Multi-Template Document Tool · User Guide

A **fully client-side, zero-dependency, offline** web tool. Open a single HTML file to fill in and generate Word documents (.docx) right in your browser — no installation, no internet connection, and nothing uploaded to any server.

---

## Key Features

- **Single-file**: just double-click to open in a browser; works even offline.
- **Zero dependencies**: the Word-generation logic is written entirely in native JavaScript (hand-built zip packaging + docx XML), with no CDN or external libraries.
- **Privacy-safe**: all data (including uploaded ID images) is processed locally in your browser; nothing is sent over the network.
- **Live preview**: fill in the form on the left, see an A4 preview update in real time on the right.
- **Multiple templates**: four built-in templates, switchable from the top dropdown.
- **Trilingual**: Simplified Chinese, Traditional Chinese, and English — both the interface and the fixed wording in generated documents switch together.

---

## Four Templates

### Template 1 · Employment (Resume) Certificate
A complete employment certificate with fields for name, ID type and number, position, hire/leave dates, department, salary, supervisor details, etc., plus an optional page of ID document scans. Includes rich validation (see below).

### Template 2 · Approval Form
A common approval form with fields for applicant, department, application date, approval type (Leave / Reimbursement / Procurement / Seal Use / Other), reason, amount and currency, start/end dates, approver, and remarks. Generates an approval form with an info table, reason, signature lines, and a seal area.

### Template 3 · Announcement
A standard official-announcement layout with fields for issuer, title, document number, body, signed-by, and date. The body is auto-split into paragraphs by blank lines with first-line indentation; the signature and date are right-aligned at the bottom.

### Other · Free Layout
A modular document editor where you can freely add, remove, and reorder blocks: Header, Heading, Paragraph, Table, Statement, Seal, and Image Page. The header supports a logo upload plus company name and slogan; each table row can have validation toggled individually. Fully free-form layout.

---

## Validation Rules (Template 1)

If any of these fail, generation is blocked and a hint is shown in the relevant area:

- **Name**: Chinese-only or English-only, no mixing; at least 2 Chinese characters or 2 English letters.
- **ID number**: validated by length per the selected ID type. The four PRC ID types (Resident ID Card, HK/Macao & Taiwan Residence Permits, Foreign Permanent Resident ID) are additionally checked for: 18 digits, a valid birth date in positions 7–14 (YYYYMMDD), and a correct check digit.
- **Position type & age**: when the ID is one of the four PRC types above, age (in full years, based on the current system date) is verified against the position requirement — Full-time ≥18, Internship ≥16, Part-time ≥12. No age check for the "Other" position type or for IDs without a birth date (e.g. passport).
- **Hire/leave dates**: if a leave date is set, it must be later than the hire date.
- **Salary amount**: if entered, must be Arabic numerals with a non-zero leading digit (a single 0 and decimals below 1 are allowed).
- **ID scans**: optional, up to 4 images; if provided, an attachment page is added at the end of the document.

---

## Input Aids

- **18-digit PRC IDs**: the input field displays them as "6-digit region code + space + 8-digit birth date + space + last 4 digits" (e.g. 530112 20101213 6614) for easy checking; validation and document output still use the raw number without spaces.
- **Date pickers**: hire, leave, application, and validity dates all use date pickers and display uniformly as YYYY/MM/DD.
- **Defaults**: supervisor name, email, and fax show N/A when left blank; supervisor phone shows a default number when blank; validity defaults to 6 months after the application date when blank; application date defaults to today when blank.
- **Currency symbols**: salary currency is shown as CN￥ / HK$ / US$.

---

## How to Use

1. Open the HTML file in a browser (Chrome / Edge / Safari, etc.).
2. Choose a language and a template at the top.
3. Fill in the form on the left and watch the live preview on the right.
4. Once all validations pass, click "Download Word" at the top right. The resulting .docx opens in Word or WPS.

---

## Notes & Limitations

- The web preview is laid out in screen pixels while Word uses A4 paper, so the look is consistent but not pixel-identical.
- The native date picker's appearance varies by browser, but the output format is uniform.
- The tool contains no specific company branding; the header and organization name are entered by the user.
- English translations follow an HR / official-document register; if your company has preferred terminology, you can replace the corresponding text in the document.
