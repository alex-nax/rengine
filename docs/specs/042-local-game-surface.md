# Local SDL2/OpenGL game surface v1

Status: implementation and qualification in progress under F42/F43/F55. This is a local desktop
transport, separate from future Quest pairing and compressed media streaming.

The game remains a sidecar-owned process bound to an explicit root. A native adapter observes
the SDL2/OpenGL swap boundary and supplies input at the SDL event boundary. The first macOS
proof uses an explicitly loaded interposer for the existing development NOLF executable. A
portable cooperative API supports host-owned integration; Windows host wiring and actual game
qualification are still required. Neither an external window nor a screenshot completes this
contract. Both swap call sites in current NOLF must pass through the adapter.

The sidecar creates a random per-game capability before launch and listens on loopback. Two
TCP connections authenticate with `RENGINE/1 FRAME <64 hex characters>\n` and
`RENGINE/1 INPUT <64 hex characters>\n`. A capability belongs to exactly one live game session.
Frame upload and input download use separate sockets so blocked display delivery cannot delay
input handling or block the render thread. Connection headers have bounded length/time.

Frame packets contain six little-endian uint32 values: magic `0x31464752` (`RGF1`), width, height,
sequence, byte count and flags. Flags must be zero: tightly packed RGBA8, bottom row first. Width
and height are 1–1920 and 1–1080, and byte count must equal width × height × 4. The receiver
validates the header before allocating. Each stage retains at most the current frame and one
pending replacement. Slow displays skip old frames; they never accumulate an unbounded queue.
The initial capture ceiling is 30 fps. CPU readback is a qualification implementation whose
frame cost must be measured before making performance claims.

Input packets contain eight little-endian int32 values. Kind 1 carries SDL scancode/down/repeat;
kind 2 carries absolute x/y and relative dx/dy; kind 3 carries SDL button/down/x/y; kind 4 carries
wheel x/y; kind 5 carries focus; kind 6 releases held keys/buttons. Remaining values are zero.
Coordinates refer to the game's logical window. Browser scaling, bottom-up frame presentation,
relative pointer movement and native drawable scaling are explicit adapter responsibilities.
Only the displayed game session receives input; blur/detach releases held input. Malformed or
out-of-range input is rejected. Native queues are bounded and reset held input on disconnect.

The native render hook preserves read framebuffer/buffer and pixel-pack state. Network I/O runs
off the GL thread. Adapter failure leaves the game session visible as disconnected or exited;
the UI does not replace it with a static successful preview. Closing its tab detaches the view;
Stop targets the process and releases its transport. Reattachment keeps the same process ID.

Verification begins with malformed/truncated frame tests and a real SDL/GL producer, then the
actual local NOLF build/assets with live changing pixels and game input. Verify moves, resize,
focus/release, slow consumers, abnormal exit and reattachment separately. Windows and macOS
evidence remain separate; a passing fixture never establishes NOLF playability.

Sources consulted for the seam:

- https://wiki.libsdl.org/SDL2/SDL_GL_SwapWindow
- https://wiki.libsdl.org/SDL2/SDL_PollEvent
- https://github.com/apple-oss-distributions/dyld/blob/main/include/mach-o/dyld-interposing.h
