# Cursor Bridge Dashboard Design Contract

## Direction and reference

The console belongs to the CommandCode Bridge family: the kiro-lb operations
layout with yelixir.dev typography and warm dark/light materials. The concrete
reference is the rendered local commandcode/dashboard/index.html and app.css,
not its older editorial DESIGN.md. No kiro-lb source is copied.

## Tokens

- Dark canvas #0e0c0a, surface #15120f, inset #1b1714; text #f1ede5,
  secondary #cbc2b4, muted #a69b8c, accent #e5b45b, healthy #7fb8bb,
  error #d9805c. Neutral rules use cream at 12% / 22% opacity.
- Light canvas #f1ede5, surface #f7f4ee, inset #ebe5da; text #28231f,
  secondary #5c544a, muted #6b6258, accent/error #9f4d2e, healthy #1d6a72,
  warning #9a6a12; rules #d2cbc0 / #bdb4a6.
- Display: Space Grotesk; body: DM Sans; brand italic: Instrument Serif;
  machine values: JetBrains Mono. Fonts use yelixir.dev with system fallbacks.
- Type scale: 11, 12, 13, 14, 15, 18, 24, 30px. Korean system fallback
  remains legible; prose uses keep-all and overflow-wrap for machine strings.
- Spacing: 4, 8, 12, 16, 20, 24, 32, 40px. Radii: 2, 6, 14px and pill.
- Header glass: dark surface at 90% / light canvas at 90%, blur 16px.
  One shared spectral brand mark, thin neutral panel rules, no accent edges.
- Motion: 160ms press transform and 260ms toast opacity/transform.
  Reduced motion disables transitions. No decorative continuous animation.

## Layout and scroll ownership

Normal document scrolling owns the page; the header is sticky. A centered
1320px maximum content track has 16–40px fluid gutters. The tab strip wraps into
five equal named controls, keeping labels visible on mobile. Overview, credentials,
models, settings, and information use the same reusable panels.

StyleGallery sources: recipes/dashboard.md, page-grid, card-grid, cluster,
and design-engineering/component-contract.md. Cards reflow with intrinsic grids;
only the named credential table region scrolls horizontally. At 720px header
controls wrap and paired panels become a single column. Tables expose keyboard
scrolling; other primary content never needs horizontal scrolling.

## Components and states

- Header: shared brand, health badge, live/pause, refresh, theme and API-key actions.
- Tabs: button tablist with selected state, roving tabindex, arrows/Home/End;
  associated panels are hidden semantically and drafts survive switching.
- KPI cards: real requests, in-flight count, success rate and average latency.
- Overview panels: current terminal outcomes and caller-supplied route aggregates;
  unavailable, empty, pending and stale metrics are explicit, never invented.
- Cards, fields, pill buttons, native details, switches, badges, status messages
  and the auth dialog share tokens across every tab and theme.
- Credentials retain create/delete, weights, plans, Ultra/Fable gating, reserved
  env/system restrictions, and the two real account-usage pools.
- Models retain family folds, search, individual/bulk override and reset actions.
- Settings retain routing/failover and Max Mode hot updates; server address stays
  read-only. There is no fictitious save/restart operation.

## State ownership and accessibility

Existing PATCH handlers own mutations and pending state. Refresh must not discard
credential drafts or model search. The metrics controller owns its request and
bounded polling timer, avoids overlaps, pauses when hidden, and aborts on page
exit. Theme is local presentation state, unrelated to authentication.

Controls use native labels, accessible names and visible focus rings. Status is
text plus color. Progress includes numeric ARIA semantics. Tabs have keyboard
navigation; the auth dialog restores focus. Busy mutation controls prevent duplicate
submissions without blocking navigation. Empty, error and recovery states are visible.

## Verification and boundaries

Capture every tab at 375, 768 and 1280px, both themes, empty/error/auth states,
keyboard navigation, long identifiers, model search, mutations and recovery.
Verify actual HTTP behavior with an isolated server and non-secret fixtures.
The commandcode reference defines family resemblance, not identical product data.
No new framework, fake metrics, production config changes or background history
storage is introduced. External fonts may be unavailable offline; fallback is explicit.

consumer_reference: not_applicable — this product consumes spatial recipes, not
a StyleGallery conformance profile. No accessibility debt is intentionally accepted.
