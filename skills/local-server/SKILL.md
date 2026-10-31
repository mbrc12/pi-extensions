---
name: local-server
description: Link files with the user's localhost:1002 home-directory server, and write Markdown that its renderer draws — KaTeX math, Mermaid diagrams, and RDKit chemistry fences (smiles, molecule, reaction, properties). Use when sharing a path with the user, or when writing markdown with chemistry blocks or diagrams.
license: MIT
---

# Local home-directory server

A server at http://localhost:1002 serves everything under `$HOME`. It also renders `.md` files in
process with KaTeX math, Mermaid diagrams, Prism highlighting, and RDKit.js chemistry blocks.

## Linking files

Whenever you create an `.html` or `.md` file, give the user a clickable URL plus the raw path.

- Pattern: `http://localhost:1002/<relative path from $HOME>/<file with extension>`
- Follow it strictly, including `http` and never `https`.
- Prefer this for html and md files; other file types matter less.
- Always include the raw path alongside, or as the link text.

## Never restart the server

`~/Applications/serv.app` is a menu-bar app in a live user session, often mid-task.

- Do not run `launchctl kickstart`, `launchctl bootstrap`, `kill`, `pkill`, `open -a`, tray automation, or anything else that quits or relaunches it.
- When a change needs new code or settings, make the change and ask the user to quit and reopen the app from the menu bar.
- Reading pages with `curl` or `agent-browser` is always fine.
- Check changed pages in a browser with `agent-browser` rather than assuming they work.

## Chemistry fences

Four fences, all drawn by RDKit.js:

- `smiles` — one structure per line, shown side by side; each line may end with a caption after a pipe character.
- `molecule` — one structure, either a SMILES line or a JSON object.
- `reaction` — one reaction scheme, either a reaction SMILES such as `A>>B` or a JSON object.
- `properties` — a descriptor table, one molecule per line, one RDKit descriptor per row.

Options override in this order: a `chem-options` block for the whole document (removed from the
page), the fence header written as `{.smiles fixedBondLength=36}`, then a JSON body, which is the
only level that accepts lists and maps.

Useful keys: `fixedBondLength`, `width`, `height`, `legend`, `caption`, `atoms`, `bonds`,
`atomLabels`, `addAtomIndices`, `addBondIndices`, `rotate`, `kekulize`,
`highlightAtomMultipleColors`, `highlightByReactant`.

```{.smiles fixedBondLength=36}
CCO | ethanol
```

```molecule
{ "smiles": "CCO", "legend": "ethanol, with atom indices and highlights", "atoms": [0, 1], "addAtomIndices": true }
```

### Drawing behaviour

- Every drawing uses one bond length, so atom labels are the same size across a page, and each is cropped to its own molecule.
- `fixedBondLength` resizes a whole page at once.
- `width` with `height` pins the canvas instead of cropping, and keeps an in-image `legend` inside the drawing; a cropped drawing shows the legend as the caption.
- Bad SMILES produce a visible message rather than a blank box.
- Stereochemistry comes from `@`, `@@`, `/` and `\`. A structure with none is drawn flat, meaning "not specified", not "known to be achiral".

### Do not regress

- Do not reintroduce a white background, a fixed-size box, or SmilesDrawer, whose ring geometry is poor on fused rings.
- Curved-arrow mechanisms are not supported; use a Mermaid diagram for a mechanism outline.
