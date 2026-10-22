# XML schema

One `<book>` including many `<chapter>` files. Element and attribute names are fixed;
`bookify.py` rejects anything else.

```xml
<book title="Book Title" author="Author Name" edition="Third edition · Publisher, 2005">
  <include src="ch01.xml"/>
  <include src="ch02.xml"/>
</book>
```

```xml
<chapter n="3" title="Chapter 3 — Foundations" eyebrow="Author · Book · 3rd edition">
  <section id="s3-1" n="3.1" title="Historical introduction">
    <p>Prose with inline maths $k = 2\pi/\lambda$ and a reference to
       <ref to="eq-3-12" soft="yes" text="(3-12)"/>.</p>

    <eq id="eq-3-12" n="3-12">\nabla^2 u + k^2 u = 0</eq>
    <eq id="eq-3-13" n="3-13" src="figures/eq3-13.png"/>      <!-- unreadable: crop -->
    <eq id="eq-3-u4" n="" numbered="no">a = b + c</eq>          <!-- unnumbered -->

    <fig id="fig-3-2" n="3.2" src="figures/fig3-02.png" alt="Ray diagram of a lens">
      Caption text, no leading "Figure 3.2 —"; the renderer adds it.
    </fig>

    <table id="table-3-1" n="3.1" caption="Symbols used in this chapter">
      <columns><col>Symbol</col><col>Meaning</col></columns>
      <row><cell>$k$</cell><cell>wavenumber</cell></row>
    </table>

    <list><item>First point</item><item>Second point</item></list>
    <note>A remark set in smaller type.</note>

    <demo id="demo-3-1" n="3.1" title="Checking the dispersion relation">
      <p>Short setup sentence.</p>
      <code lang="python">k = 2 * pi / lam
print(k)</code>
      <output>9.93e+06</output>
      <api><fn name="np.fft.fft2" doc="https://numpy.org/doc/stable/reference/generated/numpy.fft.fft2.html">
        Computes the 2-D discrete transform, the discrete form of <ref to="eq-3-12"/>.
      </fn></api>
      <fig src="figures/demo3-1.png" alt="Two curves that coincide">Output plot.</fig>
      <note>Optional remark.</note>
    </demo>

    <section id="s3-1-1" n="3.1.1" title="A subsection">
      <p>Nested sections are allowed to any depth; the sidebar indents them.</p>
    </section>
  </section>

  <problems>
    <problem id="prob-3-1" n="3-1"><statement>Show that ...</statement>
      <solution>One line of reasoning, not a full worked answer.</solution></problem>
  </problems>

  <footnotes><footnote n="1">Footnote text.</footnote></footnotes>
</chapter>
```

## Inline elements

| element | use |
| --- | --- |
| `$…$` | inline maths (KaTeX). Escape `<` as `&lt;`; `&` as `&amp;`. |
| `<em>`, `<strong>`, `<code>` | emphasis, strong, inline code |
| `<ref to="ID" soft="yes" text="…"/>` | cross-reference; `text` is the fallback wording |
| `<link href="…">label</link>` | external link |
| `<fnref n="1"/>` | footnote marker |
| `<br/>` | line break inside a statement |

## Reference resolution

`<ref to>` looks up the target's kind and number:

| target kind | renders as | example |
| --- | --- | --- |
| `eq` | (chapter-number) | (3-12) |
| `fig` | Fig. chapter.number | Fig. 3.2 |
| `section` | §number | §3.1.1 |
| `demo` | Demo number | Demo 3.1 |
| `problem` | Prob. chapter-n | Prob. 3-1 |
| `table` | Table number | Table 3.1 |
| `chapter` | Chapter n | Chapter 5 |

Add `text="…"` when the book uses a suffix (`Prob. 3-6c`) or different wording.
Add `soft="yes"` for refs that may not exist yet: they degrade to their `text` instead of
failing the build. Use soft refs in aggregation work, hard refs in finished chapters.

## Id conventions

Chapter-scoped, so ids are unique book-wide without thinking:

```
ch3            chapter anchor
s3-1  s3-1-1   sections (dots → dashes)
eq-3-12        equation
fig-3-2        figure
table-3-1      table
demo-3-1       demo
prob-3-1       problem
```

`normalize.py ids <dir>` fixes the generic ones workers invent (`intro`, `problems`).

## Numbering

`n=` always carries the **printed** number. The renderer never renumbers and never invents
numbers: `n=""` means the book prints none, and `numbered="no"` suppresses the right-hand
label for an unnumbered display equation. Duplicate `n` values are not an error (some books
repeat), but duplicate `id` values are.

## Escaping, the two that bite

- `<` inside maths must be `&lt;` (or use `\lt`). A raw `<` opens an HTML tag and silently
  eats the rest of the line — the browser shows a short "garbage" sentence, not an error.
- `&` inside maths must be `&amp;` (alignment in `\begin{aligned}`). XML parsing fails loudly
  here, so this one is safe.
