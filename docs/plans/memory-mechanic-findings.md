# agentic-os memory persistence — mechanic findings

## Question
Does agentic-os's persistent MEMORY survive between two separate `claude -p` container
invocations against the same `/work` workspace? Gates the planned "sequential memory mode".

## On-disk memory path
- **Doctrinal (project scope).** `prompts/agentic-os/claude/rules/memory-discipline.md:3`:
  *"Memory for this repo lives at `.claude/memory/` (in-repo, gitignored)... Always read from
  and write to `.claude/memory/` ... never `~/.claude/projects/.../memory/`."* It is an
  explicit override that forbids the global/home path.
- **In-container.** The bundle is materialized at project scope and `runExecutor` runs with
  `-w /work` (`src/docker.ts:196`), so `.claude/memory/` resolves to **`/work/.claude/memory/`**.
- **Host mapping.** `/work` is a bind mount of the cell's workspace
  (`src/docker.ts:196`, `baseArgs`), i.e. **`<runResultsDir>/<cellId>/workspace/.claude/memory/`**.
- `CLAUDE_CONFIG_DIR=/cfg` (`src/config.ts:50`, `src/docker.ts:191`) is the ONLY ephemeral
  path — image-internal, discarded by `--rm`. Memory is never written there.

## Verdict: YES — memory survives

Backed by BOTH evidence classes:

- **DOCTRINAL.** Memory writes to project-scope `/work/.claude/memory/`. `--rm` discards only
  `/cfg`, not the `/work` bind mount, which persists on the host. A second `claude -p` on the
  same `/work` reads the same files. (The `.git/info/exclude` of `.claude/` in
  `src/workspace.ts:103` affects only the git DIFF, not the filesystem — memory files stay on disk.)
- **EMPIRICAL.** A completed real run left memory on the host AFTER its `--rm` container exited:
  `reports/08216436541319__.../results/webhook-hardening__agentic-os__sonnet/workspace/.claude/memory/`
  contains `MEMORY.md` plus two entries (`sandbox-process-tools.md`,
  `prisma-migrate-dev-noninteractive.md`). This proves agentic-os writes to the persistent path,
  and the files outlive the container.

## Prescription for T-mem-persist

**NO-OP for persistence** — memory is project-scope under `/work`; the bind mount already
survives `--rm`. No `CLAUDE_CONFIG_DIR` redirect or snapshot/restore is needed.

**But the sequential loop must REUSE the workspace.** Today `executor.ts:82` calls
`prepareWorkspace` once per cell (re-copies the `.claude/` bundle, re-inits git), then one
`runExecutor` (`executor.ts:122`). Sequential mode must call `prepareWorkspace` **once**, then
loop `runExecutor` over the ordered steps against that **same `workspaceDir`** — do NOT
re-prepare per step, or you reset `.claude/` and wipe accumulated memory. That reuse is the
only new work; persistence itself is free.
