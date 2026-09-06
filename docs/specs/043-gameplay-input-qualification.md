# NOLF gameplay and pane input qualification

Qualify a real flat NOLF level through the workspace's live surface, beyond menu navigation.
Use the selected local build and asset archives, but copy the executable into a disposable runtime
root with separate writable config/save directories. NOLF autosaves on entering a world; the
qualification must not overwrite the owner's saves or configuration. The normal project launch
and editor workflow remain covered separately by the combined command test.

Enter a mission through native game-menu input and observe an actual world. Verify movement and
relative aiming, with rendered before/after evidence and authoritative host state where available.
Check that releasing controls stops their effect and changing focus returns input to the intended
workspace pane. Moving/resizing the view preserves process identity and game state.

Absolute pointer coordinates originate in the presented image and must map correctly to the
host's logical window coordinates, including scaled panes and displays. Relative aiming must
remain independent of pane size. Mouse button release outside the game view, mouse capture loss,
GUI focus loss and display detach must not leave held game controls behind. Existing SDL/GL
fixtures supplement the real game with precise event/pixel assertions; they cannot replace the
live gameplay check. Extend the versioned input contract explicitly if more coordinate metadata
is required.

While mouse lock is active, Escape frees the pointer and reaches the game in the same press, so a
game opens its pause menu with the cursor already available. Held controls are not released with it:
the player is still holding them, and the game is told when a key actually comes up. A game that
claims Escape for itself is left with a way out through the platform modifier and period, which runs
the full release, drops held controls, and is never forwarded. The native desktop implements this
through SDL relative mouse mode, a narrow uncapture that leaves focus and held keys alone, and the
full release for the chord and for the workspace taking the pane away.

**Correction, 2026-09-06 (owner decision).** The original criterion read: *"While mouse lock is
active, the first Escape releases that lock and all held game controls, without also opening the
game's pause menu. Once unlocked, Escape reaches the game normally."* That made Escape unreachable
for a captured game, which is the menu key in most of them, and the owner was pressing it twice —
once to lose the lock, once to reach the game. It cost a real capture, because the pause menu was
where Save lived. Two answers were defensible: Escape releases and forwards, or Escape belongs to
the game entirely with the workspace moving to a chord. The owner took the first with a chord added,
which covers the game where Escape does something in the world and the player wants to keep the
lock. Reported by two peer sessions; recorded here because the superseded sentence was an accepted
criterion, not an implementation detail.

Keep screenshots/logs and local assets ignored. Record build/profile identity, scenario, controls,
observed behavior and remaining limits. A fixed menu screenshot, animated world without verified
input, or key-send success alone does not satisfy gameplay acceptance. Windows remains a separate
runtime gate and its pending source-transfer approval remains in force.
