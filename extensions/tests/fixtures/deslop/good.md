# Continuous integration

Every commit runs the test suite before it reaches main. A failing build blocks the merge.

## What the pipeline does

- Runs unit tests on the changed package.
- Builds the container image.
- Deploys to staging and runs the smoke tests.

A full run takes four minutes on the shared runners. Most of that time is the image build.

## Where it fails

The pipeline breaks when a test depends on network access, because the runners have no outbound route. Two tests still do this. Both are marked `xfail` until they get a local fixture.

Caching cut the average run from eleven minutes to four. The cache key covers the lockfile, so a dependency bump invalidates it once and then stays warm.

## What we do not cover

No test checks the deployment rollback path. We have run it by hand twice, in March and in June, and both times the service returned to the previous image in under ninety seconds. That is two samples, not a guarantee.
