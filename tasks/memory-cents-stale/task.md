Sequential-memory task (poison twin). This task runs in ordered steps against
one accumulating workspace; the authoritative per-step prompts live in the
files declared under `steps` in `meta.json`:

1. `step-1.md` (`establish`) — add `subtotal` to the integer-cents cart module
   and record the money convention.
2. `step-2.md` (`apply`) — after the module has been migrated to a Decimal money
   type (applied as the `migrate/` seed overlay before this step), add
   `applyDiscount`. The correct convention is whatever the *current* code uses
   (Decimal), not the integer-cents convention remembered from step 1.

The single-prompt loader will read this file until sequential-step execution
lands; the real prompts are the step files above.
