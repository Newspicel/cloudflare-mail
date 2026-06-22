# Design Guide

How the cfmail web client looks and feels. This is a **rules** document, not a snapshot — it
should stay true as the UI evolves. When a rule and the code disagree, fix one of them.

## Philosophy

Modern, **Gmail-like clarity** expressed in **Cloudflare's palette**. Calm, near-neutral gray
surfaces; one decisive warm accent (Cloudflare orange) reserved for primary actions and active
state; generous-but-compact spacing; keyboard-first. The product should read as a focused mail
client, not a dashboard full of color.

Three principles, in priority order:

1. **Content first.** Message text, subjects, and the thread list are the UI. Chrome (toolbars,
   sidebars, borders) stays quiet — low contrast, hairline dividers, no heavy fills.
2. **One accent.** Orange means "primary action" or "you are here." Don't spend it on
   decoration; if everything is orange, nothing is.
3. **Earn every pixel of contrast.** Prefer `muted`/`border` tones over hard black lines. Depth
   comes from subtle shadows and a single border, not from boxes-within-boxes.

## Foundations

### Primitives

All interactive UI is built on **shadcn-style components over Base UI** (`@base-ui/react`),
living in `src/components/ui/`. Use them — do not hand-roll overlays, focus traps, or
click-outside listeners.

- Overlays (`dialog`, `alert-dialog`, `popover`, `dropdown-menu`, `tooltip`, `select`, `sheet`)
  are **portalled, focus-trapped, and Escape-dismissable** for free.
- Compose is a non-modal `Dialog` (`modal="trap-focus"` + `disablePointerDismissal`) so the dock
  coexists with the app but still traps focus and closes on Escape.
- Class merging goes through `cn()` (`src/lib/cn.ts`). Variants are defined with `cva`.

### Color — semantic tokens only

Defined in `src/styles/globals.css` as Tailwind v4 `--color-*` variables, in OKLCH, with a
`.dark` override. **Never** write a raw hex/oklch/`#rrggbb` or a fixed Tailwind color
(`bg-zinc-800`) in a component. Always go through a token utility. The only sanctioned raw
colors are **user data** (label colors) and the **star** (`text-amber-500`).

| Token | Utility | Use for |
| --- | --- | --- |
| `background` / `foreground` | `bg-background` `text-foreground` | App canvas + default text |
| `card` / `card-foreground` | `bg-card` | Raised surfaces: panels, rows, message cards |
| `popover` / `popover-foreground` | `bg-popover` | Floating overlays (menus, popovers, toasts) |
| `muted` / `muted-foreground` | `bg-muted` `text-muted-foreground` | Quiet fills, secondary text, placeholders |
| `accent` / `accent-foreground` | `bg-accent` | Hover/active background for rows & ghost buttons |
| `primary` / `primary-foreground` | `bg-primary` | **Cloudflare orange.** Primary CTA + active nav/tab only |
| `secondary` | `bg-secondary` | Neutral secondary buttons |
| `border` / `input` | `border` `border-input` | Hairline dividers, control borders |
| `ring` | `ring-ring` | Focus rings |
| `destructive` | `bg-destructive` `text-destructive` | Delete/remove actions and their confirms |
| `success` / `warning` (`warning-foreground`) | `text-success` etc. | Status only (DNS health, expiry) |
| `sidebar*` | `bg-sidebar` … | The left rail; slightly distinct from the canvas |

Rules:
- **Orange is rationed.** `variant="primary"` buttons, the active sidebar/tab indicator, the
  unread dot, the focus ring. Nothing else.
- Destructive actions use `variant="destructive"` (solid) for the confirm button and
  `text-destructive` for inline affordances.
- Status colors (`success`/`warning`) are for **state**, never for buttons.

### Typography

- Family: **Inter var** (`--font-sans`), with `cv11 ss01 ss03` features and `-0.005em` tracking
  applied globally. Monospace (`--font-mono`) for addresses, codes, share links.
- Size ramp (this app runs **compact** — px sizes, not the default Tailwind scale):
  `10px` micro-labels/badges · `11px` meta · `12px` secondary · `13px` body & controls ·
  `14px` view titles · `15px` dialog titles · `20px` auth headings.
- Weight: `font-medium` for controls and emphasis, `font-semibold` for titles and **unread**
  rows. Unread is conveyed by weight + the orange dot, not by color alone.
- `tracking-tight` on titles; `uppercase tracking-wider` on `10px` section labels.

### Spacing, radius, elevation

- **Radius:** driven by `--radius` (0.375rem). `rounded-md` controls, `rounded-lg` cards/popups,
  `rounded-xl` dialogs and the compose dock, `rounded-full` avatars/search/pills.
- **Spacing:** compact. Control height `h-8` (sm `h-7`); toolbars `h-11/h-12`; row padding
  `py-2.5`; dialog padding `p-5`; popover padding `p-1`–`p-3`.
- **Elevation:** one soft, low-opacity shadow per layer — `shadow-sm` cards, `shadow-lg`
  popovers/menus, `shadow-xl` dialogs/compose. Shadows are tinted `shadow-black/10`–`/15`, never
  pure black. **Dividers are borders, not shadows;** a single `border` beats nested boxes.

## Components

- **Button** (`variant`: `primary` `secondary` `ghost` `outline` `destructive` `link`; `size`:
  `sm` `default` `lg` `icon` `icon-sm`). One `primary` per view. Icon-only buttons get an
  `aria-label` and a `Tooltip`.
- **Dialog vs AlertDialog vs Popover:**
  - `AlertDialog` (via `useConfirm()`) — destructive/irreversible confirms. Promise-based: see
    below.
  - `Dialog` — focused tasks with their own content/fields (shortcuts, mailbox delete + redirect).
  - `Popover` — contextual, non-blocking panels anchored to a trigger (labels, temp mailbox,
    share link). `DropdownMenu` for action/selection lists (account menu).
- **Toast** (`sonner`, themed in `ui/toaster.tsx`) — transient results and **undo**. Use a toast
  for "Archived / Undo", an inline message for validation, a dialog for a decision.
- **Inputs/Select/Checkbox/Switch/Tabs** — always the `ui/` primitives so focus rings, disabled
  states, and dark mode stay consistent. Native `<select>` is acceptable inside the admin area's
  local `Select` wrapper (restyled to match), but new option-pickers should prefer the Base UI
  `Select`.
- **Badge** — counts, kinds, TTL, status. `outline` for neutral, `destructive`/`warning` for
  state. Label chips keep their user-defined color.
- **List density (Gmail-like):** thread rows reveal the selection checkbox on hover/selection
  (`group-hover`), keep the avatar/sender prominent, and mark the active row with a 2px orange
  left rail + `bg-accent`.

### The confirm pattern

There is exactly one confirmation mechanism. Never use `window.confirm`.

```tsx
const confirm = useConfirm();
const ok = await confirm({
  title: `Delete ${name}?`,
  description: "This action cannot be undone.",
  confirmLabel: "Delete",
  destructive: true,
});
if (ok) remove.mutate();
```

The host (`<ConfirmProvider>`) is mounted once in `main.tsx`. For richer confirms that need
fields (e.g. mailbox delete with a redirect target), use a `Dialog` instead.

## Interaction & accessibility

- **Focus ring:** every interactive element shows `focus-visible:ring-2 ring-ring/40`. Never
  remove the outline without replacing it.
- **Hover/active:** `hover:bg-accent` for rows and ghost buttons; active nav/tab gets the raised
  `bg-card`/`bg-sidebar-accent` treatment plus the orange marker.
- **Keyboard-first:** global shortcuts (`j/k/c/r/f/e/#/s/u/?`, `/` for search) live in
  `app-shortcuts.tsx`; `?` opens the shortcuts dialog. New surfaces should be operable without a
  mouse and dismissable with Escape (free via Base UI).
- **Labels:** icon-only controls need `aria-label`; overlays carry a `Title` (visible or
  `sr-only`). Don't wrap a custom component in a bare `<label>` — give the control an `aria-label`
  or use a real `htmlFor`/`id` pair.
- **Motion:** short (100–200ms), token-driven via Base UI `data-starting-style` /
  `data-ending-style`. Respect reduced-motion; keep transitions to opacity/scale/translate.

## Do / Don't

- **Do** reach for a `ui/` primitive before writing markup. **Don't** rebuild overlays,
  focus traps, or click-outside handlers by hand.
- **Do** keep orange for primary/active. **Don't** use it for borders, icons, or decoration.
- **Do** express color through semantic tokens. **Don't** hardcode hex or fixed palette classes
  (exceptions: user label colors, the amber star).
- **Do** confirm destructive actions with `useConfirm()`. **Don't** call `window.confirm`.
- **Do** stay compact (13px body, `h-8` controls). **Don't** import the default Tailwind type
  scale and balloon the density.
- **Do** show one shadow + one border per layer. **Don't** nest bordered boxes inside bordered
  boxes.
