# ${key} — ${title}

You were started on this task from the workspace's Tasks pane. It is the whole of your assignment;
finish it, or say clearly what stopped you.

- Task: `${key}` (id `${id}`)
- Title: ${title}
- Labels: ${labels}

Acceptance criteria:

${criteria}

Before you write anything:

1. Read this project's agent instructions (`AGENTS.md`, `CLAUDE.md`, or whatever the root carries)
   and follow them. They outrank this prompt wherever the two disagree.
2. Take the project token before any exclusive edit — a file two agents could touch, the task
   inventory, a build directory. `token_status` says who holds it; `token_contest` takes it, with
   one line saying what you are about to do. Release it with `token_release` when that work is done.
   The workspace enforces the token on what passes through it and shows every hold on the feed; your
   own editor and shell are not gated, so the token there is a promise you keep.
3. Record progress the way this project records it — its progress log, its inventory, its commit
   conventions — not in a form of your own.

Write the task's state back through the workspace's task tools (`task_update`), so the pane and
everybody watching the feed see it move. Do not edit the inventory file by hand.
