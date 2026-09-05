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
remain independent of pane size. Mouse button release outside the canvas, pointer capture loss,
GUI focus loss and display detach must not leave held game controls behind. Existing SDL/GL
fixtures supplement the real game with precise event/pixel assertions; they cannot replace the
live gameplay check. Extend the versioned input contract explicitly if more coordinate metadata
is required.

Keep screenshots/logs and local assets ignored. Record build/profile identity, scenario, controls,
observed behavior and remaining limits. A fixed menu screenshot, animated world without verified
input, or key-send success alone does not satisfy gameplay acceptance. Windows remains a separate
runtime gate and its pending source-transfer approval remains in force.
