# Dashboard Design Contract

## Thesis

The management console is an operator's ledger: warm paper, dark ink, visible rules, and
compact status evidence. It must feel precise and calm rather than app-like or decorative.
New controls preserve the existing editorial console instead of introducing a second visual
language.

## Tokens

- Canvas `#f1ede5`, paper `#fffdf8`, inset paper `#f7f1e8`
- Ink `#28231f`, muted text `#6d665e`, rules `#d9d0c4`
- Teal `#1f6f78` for healthy/primary operational state
- Rust `#9f4d2e` for secondary emphasis and errors
- Gold `#b57920` for focus and warnings
- Serif headings; system sans for controls and status text; monospace for IDs and values
- Square controls and panels; no rounded cards, gradients, or ornamental shadows beyond the
  existing card shadow

## Layout

- One centered column, maximum width 1120px
- Cards are separated by dark top rules and generous vertical rhythm
- Credential policy, credential table, and credential usage remain inside the same credential
  card
- At 760px and above, paired data uses two columns; below 760px it stacks
- Tables may scroll horizontally on narrow screens; usage summaries must never require
  horizontal scrolling

## Credential Usage

- One ledger panel per credential, headed by label/ID, plan, freshness, and next reset
- Exactly two primary progress rows:
  - Cursor Models — teal, membership supplied by `autoBucketModels`
  - Other Models — rust, all non-Cursor models
- Percent is the primary value. Exact spend/limit/remaining appears only when supplied by the
  upstream response; unknown values render as `—`
- `billingCycleEnd` is labeled as the next usage reset, never subscription expiry
- Fresh, stale, and unavailable states use existing good/warn/bad colors and plain text
- Manual refresh is a secondary button and does not block credential routing controls

## Interaction and Accessibility

- Every control has a visible label and keyboard focus outline
- Progress bars expose a text value and ARIA progress semantics
- Loading and refresh changes use existing `aria-live` status surfaces
- Disabled controls remain legible and explain why they are disabled
- Korean copy uses `word-break: keep-all` where sentence endings could split
- Animations are limited to existing short state transitions and respect reduced motion
