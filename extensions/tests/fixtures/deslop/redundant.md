# Why the cache key changed

The runner cache was rebuilding on every branch. We changed the key to include the lockfile hash instead of the branch name.

## The cache was rebuilding too often

Every branch had its own cache, so a push to a feature branch started cold. The key was `runner-${branch}`, which meant ten branches meant ten caches and almost no reuse. Builds took eleven minutes instead of four.

## Cache misses cost eleven minutes

Because the cache key contained the branch name, each branch built from scratch and a full build took eleven minutes rather than four. That is the same problem stated again: the branch name in the key prevented reuse across branches.

## What we changed

The key is now the sha256 of the lockfile, so every branch shares one cache. A dependency bump invalidates it once, then it stays warm. Average build time is four minutes, and the first build after a bump is eleven.

## What we did not measure

We have not measured the effect on the runners' disk usage. Three caches used roughly 4 GB; one cache should use less, but that is an assumption.
