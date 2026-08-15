---
name: Kalamata
description: Design tokens and interface rules for a compact desktop Steam depot manager.
colors:
  parchment: 'oklch(0.985 0.006 95)'
  ink: 'oklch(0.205 0.018 90)'
  paper-card: 'oklch(0.995 0.003 95)'
  field-olive: 'oklch(0.43 0.105 120)'
  olive-ink: 'oklch(0.985 0.006 95)'
  dry-grass: 'oklch(0.94 0.02 100)'
  dry-grass-ink: 'oklch(0.28 0.04 105)'
  weathered-paper: 'oklch(0.95 0.014 95)'
  faded-ink: 'oklch(0.52 0.025 90)'
  olive-wash: 'oklch(0.91 0.04 110)'
  signal-red: 'oklch(0.58 0.22 27)'
  pencil-line: 'oklch(0.88 0.018 95)'
  focus-olive: 'oklch(0.56 0.1 120)'
typography:
  headline:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    fontSize: '2.25rem'
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-0.025em'
  title:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    fontSize: '1.125rem'
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.875rem'
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.75rem'
    fontWeight: 500
    lineHeight: 1.4
  metadata:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    fontSize: '0.75rem'
    fontWeight: 400
    lineHeight: 1.4
rounded:
  compact: '0.25rem'
  control: '0.5rem'
  surface: '0.625rem'
  panel: '0.875rem'
  pill: '9999px'
spacing:
  xs: '0.25rem'
  sm: '0.5rem'
  md: '0.75rem'
  lg: '1rem'
  xl: '1.5rem'
  2xl: '2rem'
  3xl: '2.5rem'
components:
  button-primary:
    backgroundColor: '{colors.field-olive}'
    textColor: '{colors.olive-ink}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '0.5rem 1rem'
    height: '2.25rem'
  button-outline:
    backgroundColor: '{colors.parchment}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '0.5rem 1rem'
    height: '2.25rem'
  input:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '0.25rem 0.75rem'
    height: '2.25rem'
  status-badge:
    backgroundColor: '{colors.dry-grass}'
    textColor: '{colors.dry-grass-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.pill}'
    padding: '0.125rem 0.5rem'
---

# Design system: Kalamata

## Overview

### Compact desktop utility

Kalamata uses compact layouts to show local resources, readiness, and operation progress. Parchment neutrals form the base palette. Field Olive marks actions, keyboard focus, and successful states.

Use spacing, dividers, tonal fills, and explicit labels instead of decorative containers. Keep controls compact. Do not use neon palettes, dramatic gradients, glass effects, or promotional decoration.

### Characteristics

- Warm neutral canvas with a restrained olive operational accent.
- Compact desktop density that remains usable in narrow, resizable windows.
- Flat, border-led structure with tonal surfaces for state and grouping.
- System sans for interface language and monospace for paths and identifiers.
- Use Steam metadata and readiness states as displayed product identifiers. Do not add decorative product branding.

## Colors

The palette pairs warm paper neutrals with a muted field olive, using red only for actionable failure and validation states.

### Primary

- **Field Olive.** Primary buttons, focus accents, progress, and affirmative operational signals. Keep it around action and state rather than using it as a decorative wash.
- **Olive Ink.** High-contrast text and icons placed on Field Olive.

### Secondary

- **Dry Grass.** Quiet status badges and secondary controls that need grouping without competing with the primary action.
- **Olive Wash.** Hover and selection feedback on otherwise neutral controls.

### Neutral

- **Parchment.** The application canvas and default control surface.
- **Paper Card.** Slightly brighter popovers and contained surfaces.
- **Ink.** Primary copy, headings, and high-value metadata.
- **Weathered Paper.** Muted panels, queue backgrounds, skeletons, and empty-state marks.
- **Faded Ink.** Supporting copy, secondary metadata, and inactive icons.
- **Pencil Line.** Dividers, input strokes, and structural borders.
- **Signal Red.** Validation, unavailable resources, and download failures only.

**Field Olive usage.** Field Olive marks actions, focus, progress, and success. Do not use it as decoration.

**Non-color status indicators.** Pair every success, warning, unavailable, and failure state with explicit text or an icon.

## Typography

**Display font.** System UI sans-serif
**Body font.** System UI sans-serif
**Label and monospace font.** System monospace stack

Use system fonts to match platform controls. Use weight and size for hierarchy, tabular numerals for numeric values, and monospace for metadata.

### Hierarchy

- **Headline** (semibold, up to 2.25rem, tight tracking): App names on the details surface; allow wrapping rather than truncating identity.
- **Title** (semibold, 1.125rem): Section and collection titles.
- **Body** (regular, 0.875rem): Instructions, errors, and general interface copy.
- **Label** (medium, 0.75rem): Supporting status and compact metadata; do not use this tier for information required to make a consequential decision.
- **Metadata** (regular mono, 0.75rem): Install paths, manifests, and technical identifiers. Use tabular numerals for IDs, counts, sizes, and percentages.

**Operational text size.** Use muted 0.75rem text only for supporting information. Keep readiness, error recovery, and next-step instructions at body size with sufficient contrast.

## Layout

Screens use a centered single-column shell: the home surface is capped at 48rem and details at 64rem. Page gutters begin at 1rem and expand to 2rem from the small breakpoint. Vertical page spacing expands similarly, preserving compactness in narrow desktop windows without turning the interface into a mobile-only stack.

Use natural document flow and `minmax(0, 1fr)` for metadata-heavy grids. App identity pairs artwork with metadata above the small breakpoint and stacks below it. Operational sections may split into content and action columns only when enough width exists; the primary action becomes full-width before that point. Paths, names, and technical strings must shrink, truncate, or wrap without forcing horizontal scrolling.

Use 4, 8, 12, 16, and 24px spacing increments. Reserve 32-40px for separation between page-level sections. Prefer dividers and whitespace over placing every group in a card.

## Elevation and depth

Persistent surfaces use no shadow. Distinguish them with tonal fills, borders, dividers, and spacing. Use small shadows for inputs and outline controls, medium shadows for transient tooltips, and the strongest shadow only for modal dialogs.

### Shadow vocabulary

- **Control edge** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.05)`): Inputs, checkboxes, and outline buttons where a physical edge aids recognition.
- **Transient lift** (`box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1)`): Tooltips and temporary overlays.
- **Modal lift** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1)`): Dialogs only.

**Default elevation.** Persistent content surfaces do not use shadows. Shadows identify temporary content or interaction priority.

## Shapes

Use rounded rectangles with radii based on control size. Compact focus targets and checkboxes use 0.25rem corners, controls use 0.5rem, and larger panels use the 0.625-0.875rem range. Reserve fully rounded pills for short badges and counts. Use thin semantic borders, not ornamental outlines or nested rounded containers.

## Components

### Buttons

- **Shape.** Compact rounded rectangle with a 2.25rem default height and medium-weight label.
- **Primary.** Field Olive with Olive Ink, used once per decision area for the next committed action.
- **Hover and focus.** A slight tonal shift on hover and a three-pixel translucent Focus Olive ring on keyboard focus.
- **Outline.** Parchment with a Pencil Line edge. Hover moves to Olive Wash.
- **Disabled.** Preserve the label and reduce opacity. Keep disabled-state reasons discoverable through the surrounding workflow. Do not add visible explanatory copy solely because a control is disabled.

### Chips

- **Style.** Fully rounded, compact status badges. Dry Grass denotes ready or grouped status, an outline denotes neutral state, and Signal Red denotes invalid state.
- **State.** Badges report status. They do not replace a control or rely on color alone.

### Cards and containers

- **Corner style.** Rows and persistent sections are usually divider-led. Muted operational panels use the surface radius.
- **Background.** Parchment at page level, Paper Card for transient surfaces, and Weathered Paper for queue, loading, and empty states.
- **Shadow use.** Keep persistent surfaces flat. Follow the elevation rules only for controls and overlays.
- **Border.** Pencil Line, typically as a single divider or perimeter.
- **Internal padding.** 1rem for compact panels and 1.5rem for dialogs.

### Inputs and fields

- **Style.** Transparent Parchment surface, Pencil Line border, 0.5rem corners, and a 2.25rem control height.
- **Focus.** Shift the border to Focus Olive and add a translucent three-pixel ring.
- **Error and disabled.** Use a Signal Red border and ring for invalid input. Disabled fields retain context at reduced opacity.

### Navigation

- Use text labels for primary navigation. Back links include an arrow icon and destination label, use Faded Ink by default, and change to Ink on hover. Keyboard focus uses the same visible olive ring as controls.

### Depot readiness rows

- Present depot identity, platform, language, install status, manifest status, and key status as one scannable unit. Ready resources use quiet secondary badges; invalid resources use Signal Red; unavailable resources remain textual and visibly disabled. Selection rows need a full-width label target and an explicit readiness reason.

### Download queue

- Place one Weathered Paper queue panel in the operation section that starts the download. Pair state text with an icon, show numeric progress with tabular figures, and retain the install destination. Limit running motion to the loader. Completion and failure remain static.

## Usage rules

### Do

- **Do** preserve warm parchment surfaces and reserve Field Olive for action, focus, progress, and success.
- **Do** make readiness and disabled reasons explicit before users commit a download.
- **Do** use dividers, spacing, and tonal fills before introducing another rounded container.
- **Do** keep paths and identifiers monospace, truncation-safe, and recoverable through a tooltip or accessible label.
- **Do** design for narrow, resizable desktop windows from the start.

### Don't

- **Don't** introduce neon color, dramatic gradients, glass effects, or glossy gaming ornament.
- **Don't** turn the interface into a generic dashboard of equal-weight cards.
- **Don't** use tiny muted copy for critical choices, errors, or recovery guidance.
- **Don't** communicate installed, ready, unavailable, or failed states through color alone.
- **Don't** fabricate capabilities, entitlement signals, download estimates, or resource metadata the application does not have.
