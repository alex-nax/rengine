# Native pane navigation and merging

Scope: close the observed KI-023 tab overflow gap and the existing F34 reorder/collapse behavior.
Keep the C/microui stack and the accepted file/session lifecycle contracts.

- A narrow or full pane has previous/next controls for its tab strip. Newly opened, selected,
  moved or restored tabs reveal themselves. Browsing the strip does not switch its active content.
  Hidden headers have no hit rectangle and cannot intercept clicks in a neighboring pane.
- Dragging onto a visible header inserts before/after that tab; dropping into content appends.
  Reordering within one pane uses the same stable tab record. Dirty editors retain their buffers
  and every view retains its original root/session identity.
- “Merge pane” collapses the active leaf into its sibling's first leaf, preserving sibling
  subdivisions and appending the moved tabs in order. Preserve the moved pane's selected tab
  when it contains views. Merging the only pane reports that it is already the only pane.
  Merge changes membership and split geometry only; it neither detaches nor stops processes.
- Keep the version-1 persisted tree compatible. Tab-strip offsets are ephemeral presentation
  state, recomputed around the selected tab after restart; actual placement/order is durable.

Acceptance uses native events: open enough files to overflow a narrow pane, reach earlier tabs,
reorder a dirty tab, resize and merge nested splits, and reopen the GUI without losing a draft
or retained PTY. Supplement this with tree invariants and actual NOLF movement into/out of a
narrow pane, followed by normal launch/restart/session checks. Windows remains a separate gate.
