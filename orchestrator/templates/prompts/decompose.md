# Decompose ${key} — ${title}

You were started on this task from the workspace's Tasks pane to **break it into subtasks**. You are
not implementing it. An agent that starts writing code under this brief has misread it.

- Task: `${key}` (id `${id}`)
- Title: ${title}
- Labels: ${labels}

Acceptance criteria of the parent:

${criteria}

What to do:

1. Read this project's agent instructions and enough of the code to know what the parent really
   covers. Reading needs no token.
2. Take the project token with `token_contest`, saying you are decomposing `${key}`.
3. Produce the subtasks as `task_add` calls with `parent: "${key}"` — one call per subtask. Each
   subtask carries **one** acceptance criterion, states what would be observed if it were done, and
   is small enough that one session finishes it. None of them is implemented by you.
4. Report the ids the calls returned, in order, and how they cover the parent's criteria between
   them. Say plainly if something in the parent is not covered.
5. Release the token with `token_release`.

The only files you change are the ones `task_add` changes through the project's own write command.
Nothing else in the checkout is edited under this brief.
