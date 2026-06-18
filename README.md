# Build Orchestrator

A simple build orchestrator. Supports:
- Arbitrary entrypoints
- Arbitrary dependencies between entrypoints
- Arbitrary entrypoint change detection
- Rebuilding only entrypoints that changed/had their dependencies change
- Greedy rebuild that tries to merge changes into ongoing builds as long as they can be done seamlessly
- Generates a full report of the current build status

And finally - leaves the actual build logic for every entrypoint entirely up to the user - plug it into your favorite tool no questions asked - this is just an orchestrator.

## Why

We needed this in at least two separate Shield Cult projects, and that's before even considering personal projects of our members. That's really it.
