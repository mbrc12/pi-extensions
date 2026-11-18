---
description: Walk through code block by block, one block per reply
argument-hint: "[file or directory]"
---
Walk through: ${@:-the code I am looking at}

- Plan in a few lines, then start block 1 in the same reply.
- Order for understanding, not file order. Say why if it differs.
- One block is the lines that do one thing. No fixed size.
- Show it as `path:start-end`, then the exact lines with line numbers in a fence, extracted by `nl -ba path | sed -n 'A,Bp'`.
- Lead with the block's goal, then what it takes in and hands out. Broad color first; skip that only when a deep explanation is already under way.
- Then intent and mechanism. Flag non-obvious decisions and the assumptions that could break.
- Run it and show real output when reading is not enough.
- Tie each block to the previous in one clause. No recaps.
- Stop after the block and end with `block 3 of 8 · next · or ask`, nothing else. Never ask to continue.
- `next` means the next block. A question gets an answer, then stop.
