# Initial local harness

Scope: repository setup only. No shared runner, engine adapter, catalog package, or training
feature is implemented by this bootstrap.

## Required behavior

- `./init.sh` resolves its own repository path, checks Python 3.9+ and Git, validates the local
  feature inventory, and checks tracked patch whitespace when this is a Git repository.
- It performs no downloads, dependency installation, sibling builds, game launches or scheduling.
- Before roadmap review, query commands explicitly label `docs/features.proposed.json` as a
  proposal. `next` offers no executable task. Once an owner-reviewed `features.json` exists,
  normal dependency-aware queries operate on it.
- The helper supports `validate`, `status`, `next`, `show <ids>` and `graph`. It is read-only;
  stdout redirection generates the graph. A `--file` override supports explicit inspection.
- Invalid JSON/shape, duplicate IDs, unknown dependencies, cycles, invalid field types and a
  passing feature without evidence or passing dependencies produce a nonzero exit and a useful
  correction message. Invalid or absent review state never activates execution.
- Readiness is limited to approved features owned by this checkout. External-workspace rows are
  handoffs; their completion requires evidence from their owner. Dependency readiness is a query
  aid, not proof that unstructured external references have been satisfied.

## Verification

Run bootstrap twice, all query modes, and invocation from another working directory. Exercise
negative inventory fixtures in a temporary directory for duplicate ID, unknown dependency, cycle,
and missing evidence. Check that an approved fixture can return a local ready task and that the
proposal returns no executable task. Check generated graph is reproducible. No native/game gate
is claimed by these checks.

Nontrivial selection/validation rationale belongs in the helper's sidecar. The shell bootstrap
is direct command orchestration and needs no file-local sidecar.
