# Meta XR Operator — initial investigation

Checked: 2026-09-05. Sources below are Meta's documentation. No download, installation, runtime
activation, device connection or native-game test was performed.

## Verified upstream capabilities

Meta offers a standalone distribution for native OpenXR applications, with desktop API-layer
and MCP-proxy setup for Windows/macOS and a separate Android packaging path. Its documented
proxy can reconnect and expose a tool list while the app is offline. The setup uses a local
app endpoint; concurrent app/port behavior therefore needs investigation before multi-session
support is claimed. [Standalone documentation](https://developers.meta.com/horizon/documentation/unity/meta-xr-operator/connecting-ai-agents/).

Operator exposes XR state, pose/input control and image capture through MCP and is labeled
experimental. Its overview also describes Unity-specific scene inspection. Those Unity features
do not prove native reLith/reSource entity inspection.
[Overview](https://developers.meta.com/horizon/documentation/unity/meta-xr-operator/).

Native applications can register custom tools through the
`XR_METAX1_agentic_external_tool` instance extension. Any engine-specific integration needs its
own capability check and thread/lifetime contract.
[Custom-tool documentation](https://developers.meta.com/horizon/documentation/unity/meta-xr-operator/custom-tools/).

Meta describes image/scene requests as on-demand rather than continuous streaming. Our inference:
the orchestrator's live game pane needs a separately verified presentation route; an MCP
connection is not evidence that the continuous viewport requirement is satisfied.
[Introduction](https://developers.meta.com/horizon/blog/meta-xr-operator-close-the-build-test-verify-loop-for-vr/).

Meta XR Simulator runs OpenXR apps in supported graphics/engine configurations, and activating it
changes the active OpenXR runtime. The documented macOS path is not proof that either port's
current graphics/XR build works with it.
[Native simulator setup](https://developers.meta.com/horizon/documentation/native/xrsim-getting-started/).

## Proposed rEngine integration boundary

- Treat Operator as an optional inspection/control provider associated with an explicit session.
- Keep visual presentation and control capabilities independently negotiated and testable.
- Detect the actual layer/runtime/tool versions and supported operations at connection time.
- Keep game-specific object/state introspection in the owning engine's adapter.
- Separate unsupported, disconnected, unavailable and verified operation results.

## Required native proof

1. Recheck the selected host's build profile, graphics binding, OpenXR loader and runtime support.
   Current donor instructions describe macOS as flat-only; Operator's macOS distribution does not
   add XR support to those builds.
2. In an isolated selected session, enable the layer and establish the documented proxy path;
   preserve the user's existing runtime/configuration and record any deliberate changes.
3. Verify session identity, one state read, a frame capture and one bounded controller/pose action
   against actual observed behavior. Preserve the evidence and restore input/session state.
4. Test disconnect/reconnect and multiple-session targeting before allowing simultaneous game
   instances. Do not assume the default endpoint can be duplicated or freely reconfigured.
5. If needed, implement one separately specified native custom tool in the owning game. Do not
   claim a Unity-style scene hierarchy before that game supplies an equivalent interface.

The immediate deliverable is a compatibility decision and scoped adapter proof, not a guarantee
of full automation, every graphics backend, or replacement of in-headset acceptance criteria.
