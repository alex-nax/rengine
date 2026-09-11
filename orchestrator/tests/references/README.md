# The reference frames

These are what `native-render.spec.mjs` judges every backend against, and they were captured from
**SDL_Renderer** before it stopped being a shipping path (charter D49, D54, spec 124).

They exist because of a consequence worth stating rather than discovering. rEngine's renderer
comparison used to run every backend against SDL_Renderer live, and that worked because SDL shared no
code with the others — it was an independent witness. Once OpenGL, Vulkan and Metal all render
through one seam, a defect in that seam moves pixels identically in all three and cross-comparison
sees nothing at all. Retiring the only independent path would have retired the only thing that could
catch it.

So the witness became data. A recorded frame cannot drift along with the code it judges, which is
exactly the property that was about to be lost, and it is the same reference-image gate vtmb-vr
already runs on its own renderer.

PNG at full resolution: 2560x1600 is 16 MiB as a BMP and about 100 KiB as a PNG, and this repository
is pinned as a submodule by two games. `tools/render_compare.py` reads either.

**Regenerating one is a deliberate act, not a fix.** A backend that stops matching these is either
wrong or has changed what the desktop looks like; the second needs an owner decision and a note
saying what changed and why, the same as any other recorded expectation in this project.
