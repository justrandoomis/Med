# MedLevo Study Surface — Design System

> Source of truth: `apps/web/src/design/` (`tokens.css`, `base.css`, `components.css`, `components/*.tsx`,
> `ThemeProvider.tsx`). Spec: §21 (terminology & RTL/LTR), §22 (design language), §23 (screens), §26 (save
> status), §55 (accessibility). Feature code uses these primitives and tokens only — no ad-hoc colours,
> spacing, radii or durations.

## 1. Direction

Calm, Apple-inspired **clarity** — not an Apple clone. Arabic-first, book-first.

* **Neutral canvas, warm paper, one accent.** The app background is a cool neutral grey; content sits on
  warm "paper" sheets; the only accent is an indigo *ink* (`#3A47A8` light / `#A3ADFF` dark).
  We deliberately avoided the generic cream-background + terracotta-accent look and teal "medical" clichés.
* **One deliberate flourish:** the sign-in sheet carries a notebook *margin rule* (a hairline in ink at the
  inline-start edge). Everything else stays quiet.
* **Motion answers actions only** (press feedback on pointer-down, overlays entering/leaving along the same
  path, drag-to-dismiss sheets). No decorative motion; reduced motion → short fades.
* **Honesty is a design rule:** no fake progress percentages, status never by colour alone, unfinished
  features are shown as unfinished, destructive actions state their impact.

## 2. Tokens (`tokens.css`)

All tokens are CSS custom properties prefixed `--ml-`.

### Spacing (rem → scales with the owner's text size)

| token | value | | token | value |
|---|---|---|---|---|
| `--ml-space-1` | 4px | | `--ml-space-5` | 24px |
| `--ml-space-2` | 8px | | `--ml-space-6` | 32px |
| `--ml-space-3` | 12px | | `--ml-space-7` | 48px |
| `--ml-space-4` | 16px | | | |

### Radii — hierarchy, not one radius everywhere

`xs 4` (inline chips, kbd) · `sm 6` (checkbox, small controls) · `md 10` (buttons, inputs, rows) ·
`lg 14` (paper sheets, popovers, grouped lists) · `xl 20` (dialogs, bottom sheets) · `pill`.

### Type

| role | token | size / line-height | notes |
|---|---|---|---|
| caption | `--ml-text-xs` | 13 / 1.55 | smallest size anywhere |
| secondary | `--ml-text-sm` | 14 / 1.6 | |
| body (UI) | `--ml-text-md` | 16 / 1.7 | Arabic needs more leading than Latin |
| emphasised | `--ml-text-lg` | 18 / 1.6 | section titles |
| screen title (phone) | `--ml-text-xl` | 22 / 1.45 | |
| screen title (wide) | `--ml-text-2xl` | 28 / 1.35 | |
| display (rare) | `--ml-text-3xl` | 36 / 1.25 | |
| book text | `--ml-text-reading` | 19 / 1.95 | Noto Naskh Arabic |

* Families: **IBM Plex Sans Arabic** (UI; its Latin glyphs are used for LTR runs) and **Noto Naskh Arabic**
  (book/reading text). Bundled with `@fontsource` (weights 400/500/600 and 400/600), served from our origin,
  precached by the PWA. Each weight file declares `unicode-range` per subset, so pages download only the
  Arabic + Latin subsets they use (verified in Chromium).
* **Arabic is never letter-spaced.** Weights: 400 regular, 500 medium (labels, buttons), 600 semibold (titles).
* `--ml-measure-reading: 42rem` (~70 Arabic characters). Text is start-aligned, never justified.
* Digits are **Latin** (`Intl` locale `ar-u-nu-latn`) so dates, page numbers («ص12») and values (`5 mg`) agree.

### Colour (light / dark) and verified contrast

| token | light | dark | on paper (light / dark) |
|---|---|---|---|
| `--ml-color-canvas` | `#EEF0F1` | `#121314` | — |
| `--ml-color-paper` | `#FFFDF8` | `#1D1C1A` | — |
| `--ml-color-ink` | `#1C2230` | `#ECEAE4` | 15.6 : 1 / 14.2 : 1 |
| `--ml-color-ink-2` | `#4F5764` | `#B5B2AB` | 7.2 : 1 / 8.0 : 1 |
| `--ml-color-ink-3` (placeholders) | `#666D79` | `#9A978F` | 5.1 : 1 / 5.8 : 1 (lowest pairings, re-measured in review: 4.6 : 1 on light `canvas`, 5.0 : 1 on dark `elevated` — still AA) |
| `--ml-color-accent` | `#3A47A8` | `#A3ADFF` | 7.8 : 1 / 8.1 : 1 |
| text on accent | `#FFFFFF` | `#121530` | 7.9 : 1 / 8.5 : 1 |
| `--ml-color-success` | `#1D6E41` | `#6FD39A` | 6.2 : 1 / 9.3 : 1 |
| `--ml-color-warning` | `#7D5200` | `#E8BA55` | 6.7 : 1 / 9.4 : 1 |
| `--ml-color-danger` | `#B3261E` | `#FF8F84` | 6.4 : 1 / 7.7 : 1 |
| `--ml-color-info` | `#0A6580` | `#72C7E3` | 6.5 : 1 / 8.9 : 1 |
| `--ml-color-control-border` | `#7E848E` | `#807D76` | ≥ 3 : 1 (WCAG 1.4.11) |

Each semantic colour has a `-soft` background; tone-on-soft contrast is ≥ 5.3 : 1 in both themes. Semantic
colours are **always paired with an icon and text** (StatusPill, SaveStatus, ErrorState, toasts).
Other tokens: `paper-2` (recessed), `elevated` (menus/popovers), `line` / `line-strong` (hairlines),
`fill` / `fill-strong` (hover, segmented track), `scrim`, `selection`, `focus`, `inverse` (tooltips).

### Elevation, motion, layout

* Shadows: `--ml-shadow-paper` (sheets), `--ml-shadow-raised` (menus, toasts), `--ml-shadow-overlay` (dialogs).
* Motion: `--ml-duration-instant 80ms`, `fast 140ms`, `base 220ms`, `slow 320ms`; easings
  `--ml-ease-standard | enter | exit`; `--ml-motion-shift` (enter/exit distance, 0 under reduced motion);
  `--ml-press-scale` (0.97 → 1 under reduced motion).
* Layout: `--ml-touch-target 44px`, control heights 32/40/48, `--ml-topbar-h`, `--ml-tabbar-h` (0 on wide),
  `--ml-content-max 72rem`, safe-area insets, z-index scale (`sticky < nav < popover < overlay < toast < tooltip`).

### Theme attributes on `<html>` (set by `ThemeProvider`)

| attribute | values | default |
|---|---|---|
| `data-theme` | `light` \| `dark` (absent → follow OS via `prefers-color-scheme`) | absent |
| `data-paper` | `on` \| `off` — paper texture | `on` |
| `data-reduce-motion` | `on` \| `off` (absent → follow `prefers-reduced-motion`) | absent |
| `data-text-scale` + `--ml-text-scale` | 0.8 – 1.6 | 1 |

The dark palette is declared twice (explicit attribute + OS media query) because CSS cannot share one block
between a selector and a media query — keep both blocks identical. `prefers-contrast: more` disables the paper
texture and strengthens hairlines/control borders; `prefers-reduced-transparency` makes the translucent bars solid.

**Paper texture** is a tiny static SVG noise tile at ≤ 9 % alpha, applied only to paper surfaces
(`.ml-paper`, dialogs, sheets, grouped lists). It is rasterised once per tile, never animated, and does not
measurably change text contrast. Owner setting: *Settings → المظهر → ملمس الورق*.

## 3. Bidi rules (§21)

* `<html lang="ar" dir="rtl">`. Use logical CSS properties (`inset-inline-start`, `padding-inline-end`, …).
* **Every English term, unit, number-with-unit, formula, version or `§` reference inside Arabic copy is isolated**:
  `<Bidi dir="ltr">5 mg IV</Bidi>` / `<Term>CT abdomen</Term>`. Plain strings like «25 KB من 1 GB» or
  «§45، §23» visibly scramble without isolation (both were caught in screenshots and fixed).
* Structured content renders through `<RichTextView value={RichText}>`: each paragraph carries `dir` and
  `lang` (RTL → `ar`; an LTR paragraph takes its runs' declared `lang`, else `en` — never the inherited `ar`); opposite-direction runs become `<bdi dir lang>`; marks (`b i u sup sub em`), kinds (`term`, `unit`,
  `formula`, `number`, `code`, `original_quote`) and claim/evidence data attributes are preserved.
  DOM order = stored logical order, so selection, copy, find-in-page and export return the stored text;
  no invisible bidi control characters are ever inserted (tests assert both).
* LTR runs use the Latin face at **1em** — never smaller or lighter than the surrounding Arabic.
* Inputs that hold LTR data (passwords, recovery codes) are `dir="ltr"`; usernames use `dir="auto"`.
* Arrow-key navigation follows reading order: in RTL, ArrowLeft = next, ArrowRight = previous
  (`navKeyFor()` in `design/utils.ts`), for Tabs, SegmentedControl and Toolbar.

## 4. Components (`import { … } from '../design'`)

| component | use | accessibility / behaviour |
|---|---|---|
| `Button` (`primary` `secondary` `plain` `destructive`; `sm` `md` `lg`; `loading`, `icon`, `iconEnd`, `fullWidth`) | one primary per view; destructive only for irreversible actions | press feedback on pointer-down; `loading` keeps focus (aria-disabled + aria-busy + announced label) |
| `buttonClass()` | style a router `<Link>` as a button | |
| `IconButton` (`label` **required**, `pressed`) | toolbar/icon actions | `aria-label`, `aria-pressed` for toggles, 44px on touch |
| `TextField`, `PasswordField`, `TextArea`, `Select` | labelled inputs with `hint` / `error` | visible label, `aria-describedby` hint+error, `aria-invalid`, ≥16px text (no iOS zoom), native select |
| `Switch` | settings that apply immediately | `role="switch"`, label at inline-start |
| `Checkbox` | confirmations, multi-select | native input (44px hit area), `:has(:focus-visible)` ring |
| `SegmentedControl` | 2–5 short exclusive options | `radiogroup`, roving tabindex, RTL-aware arrows |
| `Tabs` / `TabList` / `Tab` / `TabPanel` | switch views of one object | WAI-ARIA tabs, roving tabindex, RTL arrows, Home/End, automatic or manual activation, disabled tabs skipped |
| `Menu` / `MenuItem` / `MenuSeparator` | action lists | `role="menu"`; opens with click/Enter/Space/ArrowDown (first) /ArrowUp (last); arrows, Home/End, typeahead; Escape returns focus; Tab / Shift+Tab close it and continue from the trigger's position (the menu is portaled); disabled items show a reason |
| `Popover` | small non-modal panels (sync details) | `role="dialog"`, focus moves in, closes on Escape / outside pointer / focus leaving; it is portaled to `<body>`, so Tab from its last control closes it and continues with the control after the trigger, Shift+Tab from its first control returns to the trigger |
| `Dialog` | modal tasks | `aria-modal`, labelled by title, focus trap, app root made `inert`, Escape (when dismissible), focus returns to opener, scroll lock, same-path enter/exit. Focus traps stack: in nested modals (a ConfirmDialog opened from a Sheet/Dialog) only the innermost one handles Tab |
| `ConfirmDialog` (`impact` **required**, `destructive`, `requireText`) | confirming consequential actions | `alertdialog`; impact text block; destructive starts on Cancel; optional typed confirmation; errors inline; stays open while running |
| `Sheet` (`side`) | rails, filters, detail panels | side sheet ≥ 48rem, bottom sheet on phones with 1:1 drag-to-dismiss + velocity projection; modal semantics as Dialog |
| `useResizablePanel()` | resizable Study Rail | handle is a focusable `separator` with value; arrows resize by physical side, Home/End = min/max; `onCommit` to persist |
| `ToastProvider` / `useToast()` | transient confirmations | always-mounted live regions: polite (`status`) and assertive (`alert`, errors); errors persist; pause on hover/focus; action + close buttons |
| `Tooltip` | supplementary hints only | shows on keyboard focus and touch long-press (not hover-only), mouse hover after delay, Escape hides; `describe={false}` when it repeats an accessible name |
| `Skeleton` | layout placeholder | `aria-hidden`; static under reduced motion |
| `EmptyState` | empty screens | one clear next action |
| `ErrorState` (`inline`) | failures | `role="alert"`, what happened + what to do, retry button |
| `LoadingState` (`stage`, `done`, `total`, `unit`) | long work | stage name + **real counts**; no percentage without a known total |
| `ProgressBar` | progress | determinate only with known `value`+`max`; otherwise indeterminate (no `aria-valuenow`) |
| `StatusPill` (`tone`) | statuses | icon + text, never colour only |
| `SourceChip` | citations «محاضرة ص12» | real button; shows printed and file page when they differ (AC-04); dashed + cloud-off icon when not downloaded |
| `SaveStatus` / `SaveStatusContent` | save state | محفوظ محليًا / ينتظر المزامنة / تمت المزامنة / تعارض / خطأ with icons; optional live region |
| `Kbd`, `Toolbar`, `Breadcrumbs`, `ListItem` | misc | toolbar = single tab stop with arrows; breadcrumbs `aria-current`; list rows ≥ 52px as link/button/static |
| `Bidi`, `Term`, `RichTextView` | mixed-direction text | see §3 |
| `ThemeProvider`, `useAppearance()`, `appearanceStore` | appearance prefs | persisted locally (try/catch), synced from `/api/settings` by `lib/settings.ts` |

Layout patterns (in `components.css` / `app/shell.css`): `.ml-page` (+`--narrow`), `.ml-page__header|title|lede`,
`.ml-group` / `.ml-group__row` / `.ml-group-header` / `.ml-group-footer` (inset-grouped settings-style lists),
`.ml-list`, `.ml-stack`, `.ml-cluster`, `.ml-paper`, `.ml-visually-hidden`, `.ml-skip-link`.

## 5. Shell (spec §23)

* **Phones:** compact top bar (mark, search, offline indicator, save status) + **bottom tab bar** with four
  labelled destinations: الرئيسية / المكتبة / المراجعة / الإعدادات.
* **Tablet / desktop (≥ 48rem):** one slim translucent top bar with the same destinations, a search entry
  (`/` or Ctrl/⌘ K), the offline indicator and the save status. **No permanent sidebar.**
* `/study/…` (workspace) is full-bleed without the shell. Focus moves to the new page's `h1` after navigation;
  a skip link jumps to `#main`.

## 6. What to avoid (§22)

SaaS dashboards of counters · cards inside cards · heavy gradients · glassmorphism everywhere (only the two
navigation bars are translucent) · huge permanent sidebars · chat in the centre · decorative motion · ambiguous
icon-only actions without labels/tooltips · status by colour alone · fake percentages · "AI Verified" badges ·
buttons that do nothing (disable with the reason via `FeatureGate`) · letter-spaced Arabic · English set smaller
than Arabic · `dir="auto"` as the only bidi strategy · invisible bidi characters in stored text · uppercase
eyebrow labels and `→` appended to button text.

## 7. Verification

* Unit/component tests (`apps/web/test/`): RichTextView bidi + logical copy, Tabs/SegmentedControl RTL
  keyboard, Dialog focus trap + Escape + focus return, nested focus traps (only the innermost acts), Popover
  and Menu Tab order, ConfirmDialog impact + safe initial focus, SaveStatus text+icon, appearance attributes, search
  shortcut ignored under a modal, LTR paragraph `lang`.
* Screenshots (`apps/web/scripts/visual-check.mjs`, `gallery-check.mjs`; output in `apps/web/test-screenshots/`,
  git-ignored): setup, recovery codes, login, home shell, sync popover, offline shell, settings, destructive
  confirmation, and a dev-only component gallery (`apps/web/dev/gallery.html`, not part of the production
  build) — at 390×844 and 1280×800, light and dark. The scripts also fail on console errors and horizontal
  overflow.
