---
name: Kalamata
description: A calm, local-first field manual for inspecting Steam apps and managing depot downloads.
colors:
  parchment: "oklch(0.985 0.006 95)"
  ink: "oklch(0.205 0.018 90)"
  paper-card: "oklch(0.995 0.003 95)"
  field-olive: "oklch(0.43 0.105 120)"
  olive-ink: "oklch(0.985 0.006 95)"
  dry-grass: "oklch(0.94 0.02 100)"
  dry-grass-ink: "oklch(0.28 0.04 105)"
  weathered-paper: "oklch(0.95 0.014 95)"
  faded-ink: "oklch(0.52 0.025 90)"
  olive-wash: "oklch(0.91 0.04 110)"
  signal-red: "oklch(0.58 0.22 27)"
  pencil-line: "oklch(0.88 0.018 95)"
  focus-olive: "oklch(0.56 0.1 120)"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  metadata:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  compact: "0.25rem"
  control: "0.5rem"
  surface: "0.625rem"
  panel: "0.875rem"
  pill: "9999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.5rem"
  2xl: "2rem"
  3xl: "2.5rem"
components:
  button-primary:
    backgroundColor: "{colors.field-olive}"
    textColor: "{colors.olive-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0.5rem 1rem"
    height: "2.25rem"
  button-outline:
    backgroundColor: "{colors.parchment}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0.5rem 1rem"
    height: "2.25rem"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0.25rem 0.75rem"
    height: "2.25rem"
  status-badge:
    backgroundColor: "{colors.dry-grass}"
    textColor: "{colors.dry-grass-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.125rem 0.5rem"
---

# Design System: Kalamata

## Overview

**Creative North Star: "The Field Manual"**

Kalamata is calm and utilitarian: a compact desktop tool whose visual language makes local resources, readiness, and progress easy to inspect. Warm parchment neutrals keep the interface grounded while field olive is reserved for actions, focus, and positive operational status.

The system is quiet without becoming vague. Structure comes from spacing, dividers, restrained tonal fills, and precise labels rather than decorative containers. Controls feel compact and dependable. Avoid glossy gaming aesthetics: no neon palettes, dramatic gradients, glass effects, or promotional spectacle.

**Key Characteristics:**
- Warm neutral canvas with a restrained olive operational accent.
- Compact desktop density that remains usable in narrow, resizable windows.
- Flat, border-led structure with tonal surfaces for state and grouping.
- System sans for interface language and monospace for paths and identifiers.
- Product identity expressed through truthful Steam metadata and readiness states, not decoration.

## Colors

The palette pairs warm paper neutrals with a muted field olive, using red only for actionable failure and validation states.

### Primary
- **Field Olive:** Primary buttons, focus accents, progress, and affirmative operational signals. It should remain concentrated around action and state rather than becoming a decorative wash.
- **Olive Ink:** High-contrast text and icons placed on Field Olive.

### Secondary
- **Dry Grass:** Quiet status badges and secondary controls that need grouping without competing with the primary action.
- **Olive Wash:** Hover and selection feedback on otherwise neutral controls.

### Neutral
- **Parchment:** The application canvas and default control surface.
- **Paper Card:** Slightly brighter popovers and contained surfaces.
- **Ink:** Primary copy, headings, and high-value metadata.
- **Weathered Paper:** Muted panels, queue backgrounds, skeletons, and empty-state marks.
- **Faded Ink:** Supporting copy, secondary metadata, and inactive icons.
- **Pencil Line:** Dividers, input strokes, and structural borders.
- **Signal Red:** Validation, unavailable resources, and download failures only.

**The Sparse Olive Rule.** Field Olive marks what is actionable, focused, progressing, or successful; it is not a general-purpose decoration.

**The Status Is More Than Color Rule.** Every success, warning, unavailable, and failure state also carries explicit text or iconography.

## Typography

**Display Font:** System UI sans-serif
**Body Font:** System UI sans-serif
**Label/Mono Font:** System monospace stack

**Character:** Familiar platform typography keeps the utility immediate and native-feeling. Weight, scale, tabular numerals, and monospace metadata create hierarchy without introducing a branded typeface that the product has not approved.

### Hierarchy
- **Headline** (semibold, up to 2.25rem, tight tracking): App names on the details surface; allow wrapping rather than truncating identity.
- **Title** (semibold, 1.125rem): Section and collection titles.
- **Body** (regular, 0.875rem): Instructions, errors, and general interface copy.
- **Label** (medium, 0.75rem): Supporting status and compact metadata; do not use this tier for information required to make a consequential decision.
- **Metadata** (regular mono, 0.75rem): Install paths, manifests, and technical identifiers. Use tabular numerals for IDs, counts, sizes, and percentages.

**The Operational Legibility Rule.** Muted 0.75rem text is supporting evidence only; critical readiness, error recovery, and next-step guidance stays at body size and sufficient contrast.

## Layout

Screens use a centered single-column shell: the home surface is capped at 48rem and details at 64rem. Page gutters begin at 1rem and expand to 2rem from the small breakpoint. Vertical page spacing expands similarly, preserving compactness in narrow desktop windows without turning the interface into a mobile-only stack.

Use natural document flow and `minmax(0, 1fr)` for metadata-heavy grids. App identity pairs artwork with metadata above the small breakpoint and stacks below it. Operational sections may split into content and action columns only when enough width exists; the primary action becomes full-width before that point. Paths, names, and technical strings must shrink, truncate, or wrap without forcing horizontal scrolling.

Spacing follows a compact 4/8/12/16/24 rhythm, with 32-40px reserved for page-level separation. Prefer dividers and whitespace over placing every group in a card.

## Elevation & Depth

The system is flat and structural. Most surfaces sit at rest with no shadow; hierarchy is conveyed through warm tonal fills, borders, dividers, and spacing. Small shadows belong to inputs and outline controls, medium shadows to transient tooltips, and the strongest shadow only to modal dialogs.

### Shadow Vocabulary
- **Control edge** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.05)`): Inputs, checkboxes, and outline buttons where a physical edge aids recognition.
- **Transient lift** (`box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1)`): Tooltips and temporary overlays.
- **Modal lift** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1)`): Dialogs only.

**The Flat-by-Default Rule.** Persistent content surfaces do not use shadows; elevation signals temporary content or interaction priority.

## Shapes

Gently rounded rectangles keep the application practical rather than playful. Compact focus targets and checkboxes use 0.25rem corners, controls use 0.5rem, and larger panels use the 0.625-0.875rem range. Fully rounded pills are reserved for terse badges and counts. Borders are thin and semantic; avoid ornamental outlines or nested rounded containers.

## Components

### Buttons
- **Shape:** Compact rounded rectangle with a 2.25rem default height and medium-weight label.
- **Primary:** Field Olive with Olive Ink, used once per decision area for the next committed action.
- **Hover / Focus:** A slight tonal shift on hover and a three-pixel translucent Focus Olive ring on keyboard focus.
- **Outline:** Parchment with a Pencil Line edge; hover moves to Olive Wash.
- **Disabled:** Preserve the label and reduce opacity. Keep disabled-state reasons discoverable through the surrounding workflow. Do not add visible explanatory copy solely because a control is disabled.

### Chips
- **Style:** Fully rounded, compact status badges. Dry Grass denotes ready or grouped status, an outline denotes neutral state, and Signal Red denotes invalid state.
- **State:** Badges report status; they do not replace a control or rely on color alone.

### Cards / Containers
- **Corner Style:** Rows and persistent sections are usually divider-led; muted operational panels use the surface radius.
- **Background:** Parchment at page level, Paper Card for transient surfaces, and Weathered Paper for queue, loading, and empty states.
- **Shadow Strategy:** Flat at rest; follow the elevation vocabulary only for controls and overlays.
- **Border:** Pencil Line, typically as a single divider or perimeter.
- **Internal Padding:** 1rem for compact panels and 1.5rem for dialogs.

### Inputs / Fields
- **Style:** Transparent Parchment surface, Pencil Line border, 0.5rem corners, and a 2.25rem control height.
- **Focus:** Shift the border to Focus Olive and add a translucent three-pixel ring.
- **Error / Disabled:** Signal Red border and ring for invalid input; disabled fields retain context at reduced opacity.

### Navigation
- Navigation is text-first and sparse. Back links pair a familiar icon with a plain-language destination, use Faded Ink at rest, and move to Ink on hover. Keyboard focus uses the same visible olive ring as controls.

### Depot Readiness Rows
- Present depot identity, platform, language, install status, manifest status, and key status as one scannable unit. Ready resources use quiet secondary badges; invalid resources use Signal Red; unavailable resources remain textual and visibly disabled. Selection rows need a full-width label target and an explicit readiness reason.

### Download Queue
- Use a single Weathered Paper panel close to the triggering workflow. Pair textual state with an icon, expose numeric progress with tabular figures, and retain the install destination. Running motion is limited to the loader; completion and failure are static, explicit end states.

## Do's and Don'ts

### Do:
- **Do** preserve warm parchment surfaces and reserve Field Olive for action, focus, progress, and success.
- **Do** make readiness and disabled reasons explicit before users commit a download.
- **Do** use dividers, spacing, and tonal fills before introducing another rounded container.
- **Do** keep paths and identifiers monospace, truncation-safe, and recoverable through a tooltip or accessible label.
- **Do** design for narrow, resizable desktop windows from the start.

### Don't:
- **Don't** introduce neon color, dramatic gradients, glass effects, or glossy gaming ornament.
- **Don't** turn the interface into a generic dashboard of equal-weight cards.
- **Don't** use tiny muted copy for critical choices, errors, or recovery guidance.
- **Don't** communicate installed, ready, unavailable, or failed states through color alone.
- **Don't** fabricate capabilities, entitlement signals, download estimates, or resource metadata the application does not have.
