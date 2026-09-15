# Draft issue for Kohai — `kohai-acp` should accept `session/new.mcpServers`

**Status: draft, not filed.** Written in rEngine on 2026-09-15 for the owner to file in Kohai's
tracker (prefix `BAS-`). Everything below was verified against the checkout at
`~/hirebase-v2` on that date; line numbers are from it.

Delete this header block before filing.

---

## Title

`kohai-acp`: accept and honour `session/new.mcpServers` so an ACP client can lend the agent local tools

## Summary

`@hirebase/acp-bridge` (`kohai-acp`) discards the `session/new` request. An ACP client that offers
MCP servers — the transport's own mechanism for lending an agent tools — has them silently dropped,
and the agent runs with only its server-side tools.

This blocks driving Kohai agents from a desktop editor with local tooling: browser automation,
computer use, a project's own MCP server. Without it the integration can still hold a conversation
and file work, but the agent cannot touch the machine the operator is sitting at.

## Current behaviour, with evidence

`packages/acp-bridge/src/acp.ts:20`

```ts
.onRequest('session/new', () => bridge.newSession())
```

The handler takes no parameter, so the whole `NewSessionRequest` — `cwd`, `mcpServers` and all — is
discarded.

Nothing in production code reads it:

```
$ grep -rn "mcpServers" src/ --include="*.ts" | grep -v "\.test\.ts"
(no matches)
```

The only occurrences are in tests, always as `mcpServers: []` — satisfying the schema, asserting
nothing (`src/acp.test.ts:55,96,262`, `src/bridge.test.ts:239,256`).

The bridge also advertises no MCP capability at all. `src/capabilities.ts:48-49` declares
`loadSession: false` and `promptCapabilities`, and no `mcpCapabilities` field, so a well-behaved
client is entitled to conclude the agent supports none.

## Why the obvious fix is not enough

Kohai's agents run as Mastra turns inside Cloudflare Durable Objects, taking MCP servers from a
server-side `MCP_SERVERS` environment (`apps/docs/docs/runtime/tools-integrations-and-skills.md`).

**A cloud process cannot reach a client's loopback.** So forwarding the client's `stdio`, `http` or
`sse` server definitions to the runtime will not work: the addresses are meaningless on the worker,
and the executables are not there.

## What the protocol already specifies for exactly this

The SDK the bridge depends on (`@agentclientprotocol/sdk@1.3.0`) carries an **experimental ACP
transport for MCP**, where the server lives on the client side and is reached back over the ACP
channel:

`dist/schema/types.gen.d.ts:4770-4790`

> **UNSTABLE** — This capability is not part of the spec yet, and may be removed or changed at any
> point. ACP transport configuration for MCP. The MCP server is provided by an ACP component and
> communicates over the ACP channel using `mcp/connect`, `mcp/message`, and `mcp/disconnect`.

Relevant shapes already in the SDK:

- `McpServerAcp` with `name` and a `serverId` the provider must not reuse on one connection (`:4779+`)
- `type: "acp"` as an `McpServer` variant (`:4688`)
- `McpCapabilities.acp`, beside `http` and `sse` (`:1580+`)
- `mcpServers` on the new-session request (`:4663`)
- `mcp/connect` request parameters (`:1277`), and the routing note that the id identifies the
  component that declared the server (`:1305`)

This is the only variant that can work for a cloud-hosted agent and a client-hosted tool, because
the traffic rides the connection that already exists rather than requiring reachability.

## Proposed change

1. **Accept the request.** Pass `NewSessionRequest` into `bridge.newSession()` instead of dropping
   it. Worth doing on its own — `cwd` is also being discarded today.
2. **Advertise honestly.** Add `mcpCapabilities` to the initialize response, declaring only what is
   actually implemented. Advertising nothing is correct today and should stay correct after.
3. **Implement the ACP transport.** Accept `type: "acp"` entries, and proxy the agent's tool calls
   back to the client over `mcp/connect` / `mcp/message` / `mcp/disconnect`, so the tool executes on
   the operator's machine and the result returns to the turn.
4. **Refuse the rest by name.** `stdio`, `http` and `sse` entries from a client cannot reach the
   worker; reject them with a message saying so rather than accepting and ignoring them. A client
   that is told "not supported" can tell its user; one that is told nothing cannot.

Staging: (1), (2) and (4) are small and independently useful — they make the bridge honest about
what it does. (3) is the real feature.

## Acceptance

- `session/new` carrying `mcpServers` no longer discards them; `cwd` is likewise read.
- The initialize response advertises exactly the MCP transports implemented, and a client that
  offers an unsupported transport is told which entries were refused and why.
- With (3): a client-provided ACP-transport server is reachable from a turn — the agent calls a tool,
  the call arrives at the client, and the result reaches the turn. An end-to-end test with a trivial
  client-side server (one tool returning a constant) demonstrates it.
- A `serverId` reused on one connection is refused, per the SDK's "MUST NOT reuse" note.

## Scope and non-goals

- **Approvals stay in Kohai.** ADR 0098 is explicit that approvals never ride ACP, and nothing here
  changes that. A gated turn keeps surfacing a plan entry with a link.
- **Credentials stay as they are.** The bridge continues to read the operator's own credential; this
  changes nothing about how it authenticates or whose permissions apply.
- **Not asking for `loadSession`.** That is `BAS-935` and is a separate thing.
- **No new tool grants.** A tool the operator's client offers runs with the operator's own local
  authority, which is the point; it does not widen what the Kohai agent may do server-side.

## Why we are asking

**rEdit** — the desktop editor built by the rEngine project — is adding a generic Agent tab that
drives any declared ACP agent, with `kohai-acp` as one recipe. It offers its declared MCP servers at
`session/new` and reports, by name, which ones an agent did not take. So the integration works today
for conversation and is correct without this change; a Kohai agent simply shows as taking none.

This issue is what would let a Kohai agent use the operator's local tools. It is Kohai's call
whether that is wanted: the design deliberately asserts nothing about the bridge's behaviour and
treats this as an external prerequisite (rEngine spec 138, charter D70).

## Verified on

`~/hirebase-v2` at 2026-09-15: `@hirebase/acp-bridge@0.1.0`, bin `kohai-acp`, SDK
`@agentclientprotocol/sdk@^1.3.0` (resolved 1.3.0).
