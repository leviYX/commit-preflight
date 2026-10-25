# Commit preflight implementation plan

Goal: implement a zero-dependency DSH plugin using the course starter interface.

Design: inspect Git index by default, optionally unstaged tracked changes. Added plus deleted lines determine size. Report binary files and exclusions separately. Warn above 300 lines or 20 files, fail above 800 lines; repository .dsh-preflight.json overrides defaults. Scan additions for risky patterns without returning source snippets. Expose three starter-compatible tools and a standalone CLI. Only run explicit allowlisted package scripts, with time/output bounds. Do not stage or commit user files.

1. Write real temporary-Git integration tests; observe failures before implementation.
2. Implement Git discovery, NUL-safe numstat parsing, validated policy and added-line scanning.
3. Implement explicit project checks and plugin tool registration.
4. Add CLI, Chinese documentation, configuration example, command and skill.
5. Run tests, syntax checks, CLI smoke checks and inspect deliverables. Live DSH loading cannot be verified without the host.

## Validation

Implementation delivered in src/, with command/skill Markdown and optional pre-commit sample. Real Git integration tests cover the planned behaviors; package syntax checks include every source file. No target repository hook was installed, and no live Harness host was available for end-to-end loading. Tests validate registration using the starter's ctx.tool.define contract. The code-review agent capability was unavailable in this session; reviewed the delivered modules directly for diff scope, argument handling, secret output, side effects and process limits.
