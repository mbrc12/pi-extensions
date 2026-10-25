# Manifest and Markdown dialect

Everything the builder understands. Anything not listed here is plain CommonMark + GFM.

## `book.toml`

```toml
slug = "example-book"                   # [a-z0-9-]+, required
title = "Example Book"
subtitle = "Second edition"             # optional
author = "A. Author"                    # optional
publisher = "Example Press"             # optional
year = 2024                             # optional
language = "en"                         # optional, defaults to en
cover = "assets/cover.jpg"              # optional
description = "A short description."    # optional

[math.macros]
'\R' = '\mathbb{R}'
'\norm' = '\left\lVert #1 \right\rVert'

[vars.notes]
type = "bool"
label = "Author's notes"
help = "Show the side notes."
default = true

[vars.depth]
type = "select"
label = "Depth"
default = "full"

[[vars.depth.options]]
value = "brief"
label = "Brief"
help = "Statements and results, without derivations."

[[vars.depth.options]]
value = "full"
label = "Full"
help = "Everything, derivations included."

[[contents]]
slug = "intro"
file = "content/01-intro.md"
title = "Introduction"

[[contents]]
part = "Part One"                       # nav-only heading

[[contents.contents]]
slug = "basics"
file = "content/02-basics.md"
title = "The Basics"
```

Rules:

- Unknown keys are errors, with the TOML path.
- `slug` must match `[a-z0-9-]+` and be unique; it is the link namespace.
- `file` is relative to `book.toml` and must exist.
- A `part` entry has no `slug` and no `file`; it only groups chapters in the sidebar.
- `title` in the manifest is what the sidebar and cover show. It does **not** fall back to the
  chapter's `h1`, so always set it.
- Variables: `[vars.<name>]` with `type = "bool"` or `type = "select"`. A select needs at least
  one `[[vars.<name>.options]]`. Values match `[a-z0-9-]+`; names match `[a-z][a-z0-9_]*`.

## Chapters and anchors

```markdown
# Introduction {#ch1}

## Getting started {#s1-1 n="1.1"}

### A detail {#s1-1-1 n="1.1.1"}
```

- Give every heading an explicit `{#id}`. Without one it has no anchor, no sidebar entry, and
  cannot be linked; `check` warns.
- Heading ids must be unique within a chapter. The same id in different chapters is fine.
- `n="…"` is the printed number shown before the title. It is always safe to give it explicitly.
- Without `n`, a **top-level** heading is numbered from its position: `h1` becomes the chapter
  number, `h2`/`h3` get `1.1`, `1.1.1`. Headings inside a container or fold are not auto-numbered,
  so give them `n=` if the book prints one.
- `.unnumbered` suppresses the number but keeps the anchor.
- `n=""` also suppresses the number.
- Conventions: chapter `ch<N>`, section `s<N>-<k>`, equation `eq-<N>-<k>`, figure `fig-<N>-<k>`,
  table `table-<N>-<k>`, problem `prob-<N>-<k>`, demo `demo-<N>`. Chapters without printed numbers
  may use descriptive anchors.

## Maths

Inline: `$x$`, `$\norm{\mathbf{x}}$` once the macro is defined.

Display, numbered from the printed book:

```markdown
$$
(a+b)^2 = a^2 + 2ab + b^2 .
$$ {#eq-1-1 n="1-1"}
```

Display, unnumbered:

```markdown
$$
a = b + c
$$
```

Rules:

- An anchored equation is numbered. Without `n=`, the number is generated per chapter
  (`<chapter>-1`, `<chapter>-2`, …), which is almost never what a printed book uses: set `n=`.
- `.unnumbered` keeps the anchor but drops the number.
- Inline maths uses single `$`. A literal `<` is safe inside maths (`$x < y$`), but `\lt` reads
  better in source.
- All display-math lines are joined into one line before parsing. Consequences:
  - `\\` is required for line breaks inside `aligned`/`cases`.
  - **A `%` comment swallows the rest of the equation**, because the following lines are now on
    the same line. Delete `%` comments.
- KaTeX renders in the browser; the build stores the TeX verbatim in `data-tex`.
- Define repeated macros in `[math.macros]`, then use them as `\R` in the source.

## Figures

```markdown
::: figure {#fig-1-1 n="1.1" .wide}

![A box labelled input connected by an arrow to a box labelled output.](assets/figures/fig1-01.png)

::: caption

The system maps an input to an output; see [](#eq-1-1).

:::

:::
```

- The **first block must be the image**. Its alt text is the accessible description and the hover
  preview text.
- The caption is a nested `::: caption` block. A plain paragraph after the image becomes body text
  inside `<figure>`; the `<figcaption>` then shows only the number. The caption may contain math
  and links.
- `.wide` (with the dot) lets the caption break out of the text column. A bare `wide` token is not
  a class and is ignored.
- `n="1.1"` prints `Fig. 1.1`. Figures are never auto-numbered; omit `n` for an unnumbered figure.
- A bare `![alt](path)` outside a container is an inline image with no number and no caption.
- Image paths are relative to `book.toml`. Assets are copied to `out/assets/` byte for byte; the
  builder does **not** resize or convert them. Downsample large scans yourself.

## Containers

`::: name {attrs}` … `:::` is a generic fenced div. A bare `:::` closes the innermost container,
so nesting needs no extra colons. Blank lines around a fence are optional.

| Kind | Renders as | Notes |
| --- | --- | --- |
| `figure` | `<figure>` + `<figcaption>` | image first, `::: caption` for the caption |
| `fold` | `<details>` / `<summary>` | native, keyboard-operable |
| `index` | generated list | `of="kind-or-class"` |
| `caption` | used only inside `figure` | outside a figure it is a plain div |
| anything else | `<div class="name">` | no built-in styling |

Generic containers (`note`, `demo`, `output`, `api`, `problem`, `statement`, `region`) are just
divs. The default stylesheet does not style them, so a book that wants a boxed note must ship a
template override. Prefer ordinary headings, blockquotes, and lists unless the book provides CSS.

Folds:

```markdown
::: fold {#sol-1-1 label="Show solution" label-open="Hide solution"}

For nonzero $a$ and $b$, expand the left-hand side:

$$
(a+b)^2 = a^2 + 2ab + b^2
$$

:::
```

- `label` is the summary while collapsed (default `Show`); `label-open` while expanded (default
  `Hide`); `open` starts expanded.
- The body is ordinary Markdown and may nest another fold.
- Solutions are folds with the labels above. `::: solution` is **not** a fold alias.
- Links into a closed fold open it automatically; print expands every fold.

## Tables

```markdown
| Name | Meaning |
| --- | --- |
| $a$ | the first value |
| $b$ | the second value |

: Symbols used in this section. {#table-1-1 n="1.1"}
```

- A paragraph beginning with `: ` directly after the table is its caption.
- The trailing `{…}` on the caption line carries the anchor and printed number.
- Spell a literal `|` inside a cell as `\vert` in maths; GFM splits on `|` before inline parsing.
- Tables are never auto-numbered.

## Footnotes

```markdown
… as noted earlier.[^note]

[^note]: A short note, with $x$ if needed.
```

- GFM syntax. Definitions may sit anywhere in the file; they collect into a Notes section.
- **The label is displayed verbatim**, after comrak lowercases it. Use `[^1]`, `[^2]`, or the
  book's own numbers; keep labels lowercase and free of spaces (a multiword label is not a
  footnote and renders literally).
- Footnotes are per chapter and listed in definition order, not first-reference order.

## Cross-references

| Written | Meaning | Rendered label |
| --- | --- | --- |
| `[](#eq-1-1)` | anchor in this chapter | `Eq. (1-1)` |
| `[](basics!eq-2-1)` | anchor in chapter `basics` | `Eq. (2-1)` |
| `[the main identity](basics!eq-2-1)` | same, with prose text | as written |
| `[](#fig-1-1)` | figure | `Fig. 1.1` |
| `[](#table-1-1)` | table | `Table 1.1` |
| `[](#s1-1)` | section | `Section 1.1` |
| `[](#ch2)` | chapter `h1` | `Chapter 2` |
| `[external site](https://example.org)` | external | as written |

- **No leading `#` on the cross-chapter form.** `#anchor` is always the current file; `slug!anchor`
  has no `#`.
- Empty link text is the normal form: the target supplies the label, so printed numbers cannot
  drift.
- A generated label absorbs a preceding "Eq."/"Fig." word in the prose, so write
  `see Eq. [](#eq-1-1)`, not `see Eq. Eq. [](#eq-1-1)`.
- Explicit text is kept, and `check` warns when it looks like a label that no longer matches.
- Link to the target's anchor, not to a page path. The build rewrites `slug!anchor` to
  `slug.html#anchor`; a link to a whole chapter needs an anchor on its `h1`.
- Relative file links (`assets/errata.pdf`) are left alone and are not validated.
- A broken link renders as an **empty** `<a>`; `check` is what catches it.

## View variables and `if=`

```toml
[vars.notes]
type = "bool"
label = "Author's notes"
help = "Show the side notes."
default = true
```

```markdown
::: demo {#demo-1 n="1.1" title="a worked example" if="notes"}
…
:::

::: region {if="notes && depth != 'brief'"}
…any number of blocks, including headings…
:::

$$ … $$ {#eq-1-2 if="notes"}
```

- `if=` is valid on headings, equations, tables, code blocks, figures, and containers.
- `region` is the generic wrapper for several blocks at once.
- Conditions compose: a block inside two regions gets the conjunction.
- **Numbers do not move** when something is hidden: `Fig. 1.3` stays `Fig. 1.3`.
- A hidden heading disappears from the sidebar. A heading's own condition does **not** hide its
  body blocks; to hide a whole section, wrap heading and body in `::: region`.
- The build validates each condition. Unknown variables, a select used bare, mixed-type
  comparisons, and syntax errors are errors; an option no condition uses is a warning.
- Evaluation happens in the reader. Precedence: URL query (`?notes=0&depth=full`), then
  `localStorage`, then the manifest default. Changing a control rewrites the URL with
  `replaceState`.
- A variable that no block uses does nothing. Define the variable and gate the blocks with `if=`.

Grammar (nothing else):

```text
expr  = or
or    = and ("||" and)*
and   = cmp ("&&" cmp)*
cmp   = unary (("==" | "!=") unary)?
unary = "!" unary | atom
atom  = "(" expr ")" | "true" | "false" | string | name
string = '"' … '"' | "'" … "'"
name  = [a-z][a-z0-9_]*
```

Because the attribute value is double-quoted, write string comparisons with single quotes inside:
`if="depth == 'full'"`.

## Generated indexes

```markdown
::: index {of="fig"}
:::
```

- `of` accepts `fig`, `eq`, `table`, `section`, `chapter`, `problem`, `demo`, `fold`, `all`, or any
  class name used on a target (for example `of="demo"` matches headings carrying `.demo`).
- Entries are grouped by chapter, with the number and title, and they follow the target's `if=`.
- Use one for an index of figures, equations, demonstrations, or problems instead of maintaining
  a list by hand.

## Code

Fenced code blocks are CommonMark:

````markdown
```python
print("hello")
```
````

The language becomes `class="language-python"`. The bundle does not ship a highlighter, so code
renders styled but not syntax-coloured.

## Theme and template overrides

`theme.toml` next to `book.toml` merges into the built-in themes by key:

```toml
base_size = 19
default_font = "book"
default_theme = "paper"

[fonts.book]
label = "Book"
stack = '"Iowan Old Style", Palatino, Georgia, serif'
scale = 1.0

[themes.sepia]
label = "Sepia"
scheme = "light"          # light | dark
ink = "#2b2118"
muted = "#6a5b4a"
rule = "#d8cbb8"
bg = "#fbf6ec"
panel = "#f3ead9"
accent = "#8a4b1f"
mark = "#efe0c6"
code = "#f4ecdd"
```

- Unknown keys are errors. `scheme` must be `light` or `dark`.
- `templates/<name>.html` next to `book.toml` overrides a page template (`page.html`,
  `cover.html`, `sidebar.html`, `toolbar.html`, `pager.html`, `macros.html`). Only `.html` files
  load; the stylesheet is generated and cannot be overridden this way.

## Numbering summary

| Thing | Default | Override |
| --- | --- | --- |
| chapter heading | position in `contents`, printed `Chapter N` | `n=` on the `h1` |
| section / subsection | position, top-level only | `n=`, `.unnumbered`, `n=""` |
| equation | chapter and per-chapter count, only if anchored | `n=`, `.unnumbered` |
| figure | none | `n=` |
| table | none | `n=` |

Inserting a numbered block means renumbering the ones after it, exactly as in print. The
label-drift warning catches references that were not updated.

## Not in the tool yet

- `--single` (one self-contained file), `pack`, `open`.
- Image re-encoding or WebP conversion.
- Backlinks.
- Stylesheet overrides; per-container styling.
- Build-time KaTeX/`--prerender`.
