# PRACTIS — Design Research Brief

**Date:** 2026-09-25
**Method:** design-critique (surface identification + data-density audit) + 5 reference systems from the 54-system catalog (HashiCorp, Vercel, Sentry, Kraken, Coinbase) + anti-slop checklist.

## 1. What PRACTIS is (surface type)

- **Primary surface: Monitor + Operate** — dense dashboards/ledgers/registers (receivable, payable, LPB, WBS/CBS) plus heavy data entry (ledger lines, imports, cost checking).
- **Secondary surface: Configure** — settings, role management, import mapping.
- **Users:** 9 roles, professional daily use, desktop-first. Power users → high density tolerance.
- **Decisive constraint:** money everywhere, rupiah integers, tabular alignment is not optional. This is an accounting-grade tool, not a marketing site.

Per the data-density audit, a Monitor/Operate surface must:
- **Mono for ALL numeric data** (money, quantities, dates) — tabular alignment, columns line up
- **Color semantics fixed:** green = in/positive, red = out/over-budget, brand accent = actions/active ONLY, neutrals carry ~90% of UI
- **Status colors at 10–16% opacity bg + full-opacity text**
- **Hierarchy via luminance, not shadows:** 4-tier text (primary → secondary → muted → dim)
- **Dense tables:** header row height ≈ data row height, sticky headers, row actions on hover
- **Progressive disclosure:** dashboard = summary; detail pages = depth; advanced behind request
- **Anti-slop:** no tech gradients, no glassmorphism, no monument stats, no feature-tile grids, no center-stack hero

## 2. Reference systems evaluated

| System | Language | Fit for PRACTIS | Risks |
|---|---|---|---|
| **HashiCorp** | Enterprise infra: near-black/white, one accent, sharp 2–8px radius, whisper shadows, uppercase 13px caps labels, tight headings 1.17–1.21 / relaxed body 1.5–1.69 | **High** — "serious enterprise tool" exactly matches a cost-management system; light theme prints/reports well | None material |
| **Vercel** | Engineering precision: pure white/#171717 monochrome, shadow-as-border (no CSS borders), 3-weight type, Geist Mono uppercase technical labels, aggressive negative tracking | **High** — densest possible tables, mono-native | Sparse feel; less "warm"; negative tracking can hurt dense table heads |
| **Sentry** | Dark data-dense dashboard: deep purple-gray (#1f1633), inset buttons, uppercase 15px labels, lime accent | **Medium** — great long-session density | Dark = worse on printed exports/PDFs; purple = generic-tech-hue risk (anti-slop #2); glass effects = anti-slop #5 |
| **Kraken / Coinbase** | Finance trust signals: blue/purple accent, white surfaces | **Medium-Low** — trust yes, but consumer pill buttons (12–56px radius) fight dense tool anatomy; coin-trading identity not construction | Pills, brand hue = wrong craft layer |
| **Linear** (noted, dark dev-tool) | Ultra-minimal dark, precise | Low — dev-tool identity, dark | Identity mismatch |

## 3. Recommended direction: hybrid grounded in HashiCorp + Vercel

**Option A — "Enterprise Ledger" (recommended)**
- Light theme. Near-black text (#171717 family) on white + cool gray surfaces (#f5f5f4 / #eaeaea).
- **One accent: deep construction-blue or teal** (#0f62fe family or #0d9488) — actions + active nav only.
- **Sharp radii: 2 / 4 / 6 / 8px** — nothing pill-shaped. Instills "structural" not "consumer".
- **Type: Inter** (UI) + **JetBrains Mono** (ALL money/quantities/dates, uppercase mono for table headers/captions).
- **Uppercase 13px caps labels** for section markers (HashiCorp pattern).
- **Whisper shadows** (0.05 opacity dual-layer) or shadow-as-border — depth by luminance steps, not shadows.
- Dense tables: 36–40px rows, sticky header, header = data height.

**Option B — "Engineering Precision" (Vercel-native)**
- Pure white / #171717 monochrome. Shadow-as-border everywhere.
- Geist or Inter 3-weight (400/500/600), mono labels uppercase.
- Fewest chrome; every element earns its pixel.
- Risk: can read as "cold" for non-technical admins.

**Option C — "Dark Terminal" (Sentry-native)**
- Deep purple-gray dark theme, dense, uppercase labels.
- Best for long sessions; worst for exports; purple hue risk.

## 4. Craft constants (all options)

- Mono numerals everywhere money appears; `font-variant-numeric: tabular-nums`
- Status chips: 10–16% opacity bg + full-opacity text (e.g. checked = green 14% bg, draft = gray 12% bg, over-budget = red 14% bg)
- 4-tier text luminance scale
- Focus rings 3px solid (a11y), contrast ≥ 4.5:1
- Touch targets ≥ 44px even in dense tables (row actions on hover with keyboard fallback)
- Empty states explain WHY + next action (never blank frame)

## 5. Next step

Pick a direction → I build the PRACTIS design system (token spec + component inventory + 2–3 key-screen mockups as PNG) → approval → then app code.