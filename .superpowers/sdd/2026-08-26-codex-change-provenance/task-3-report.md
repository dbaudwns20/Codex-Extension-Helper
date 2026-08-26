# Task 3 Report: Hash-Linked Provenance Ledger

## Status

Complete.

## Files

- `src/codexProvenanceLedger.ts`
- `test/unit/codexProvenanceLedger.test.ts`

## RED evidence

Initial command:

```text
npx vitest run test/unit/codexProvenanceLedger.test.ts
```

Vitest failed during collection because `../../src/codexProvenanceLedger` did not exist. One suite failed and no tests were collected, which was the expected missing-module RED.

Self-review added an explicit regression test for a conflicting `patchUpdated` notification received after terminal completion. With that invalidation branch neutralized, the focused test failed because the ledger still returned the completed transition instead of `[]`.

## GREEN evidence

Focused command:

```text
npx vitest run test/unit/codexProvenanceLedger.test.ts
```

Output: one test file passed; 17 tests passed.

Required compile and full regression command:

```text
npm run compile && npm run test:unit && git diff --check
```

Output: compile exited 0, all 31 unit-test files and 380 tests passed, and `git diff --check` produced no findings.

## Commit

`3924a56` (`feat: track exact Codex file transitions`)

## Self-review

- The accepted-state dependency is explicitly named `AcceptedStateResolver`; the ledger never reads or treats the live filesystem candidate as its replay baseline.
- Item identity is `${threadId}\0${turnId}\0${itemId}`. Preterminal patch revisions may evolve, while the first terminal payload is authoritative. Identical duplicates are no-ops; conflicting postterminal lifecycle or payload evidence invalidates the item and clears cached transitions.
- Only `completed` items are eligible. Failed, declined, interrupted, invalid, consumed, and expired evidence cannot produce transitions.
- Exact add, update, and delete lifecycle rules are enforced around zero-fuzz patch replay. Sequential completed items for the same thread/turn/path replay from each preceding post-image and collapse into one transition with ordered item IDs.
- Consumption is keyed by normalized accepted-state URI plus exact post-image SHA-256. One file from a multi-file item can be consumed without discarding the other file's evidence.
- Pruning only removes entries. It never promotes evidence or changes confidence.

## Concerns

- `move_path` evidence deliberately produces no v1 transition because source and destination cannot yet be proven atomically.
- A same-path chain spanning different thread or turn identifiers fails closed because `ExactCodexTransition` carries one thread/turn provenance identity.
- Vitest emits the repository's existing Vite CJS deprecation warning; it did not affect test or compile results.
