import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { agentLaunch } from '../agents/config.mjs';

test('agent overlays preserve arguments and existing configuration without rewriting user files', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-agent-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contextFile = path.join(directory, 'context with spaces.json');
  await writeFile(contextFile, JSON.stringify({ rootId: '12345678-1234-1234-1234-123456789abc' }));
  const args = ['literal $(stay literal)', 'two words'];
  const codex = await agentLaunch({ agent: 'codex', executable: '/installed/codex', args, contextFile, env: {} });
  assert.deepEqual(codex.args.slice(-2), args);
  assert.ok(codex.args.some(value => value.includes('mcp_servers.rengine_123456781234.command=')));
  assert.ok(codex.args.some(value => value.includes(codex.contextFile)), 'the worker is pointed at this launch\u2019s own context file');
  assert.ok(!codex.args.some(value => value.includes(contextFile)), 'and no longer at the context file every agent on the root shares');
  const claude = await agentLaunch({ agent: 'claude', executable: '/installed/claude', args, contextFile, env: {} });
  const config = JSON.parse(await readFile(claude.args[1], 'utf8'));
  assert.equal(Object.values(config.mcpServers)[0].type, 'stdio');
  assert.deepEqual(claude.args.slice(-2), args);
  const inline = '{/* existing */ "model":"existing", "mcp":{"previous":{"type":"local","command":["existing"]}}}';
  const opencode = await agentLaunch({ agent: 'opencode', executable: '/installed/opencode', args, contextFile, env: { OPENCODE_CONFIG_CONTENT: inline } });
  const merged = JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(merged.model, 'existing'); assert.ok(merged.mcp.previous); assert.equal(Object.keys(merged.mcp).length, 2);
  const defaults = path.join(directory, 'existing-defaults.json');
  const original = '{"security":{"auth":{"selectedType":"oauth-personal"}},"mcpServers":{"previous":{"command":"existing"}}}';
  await writeFile(defaults, original);
  const gemini = await agentLaunch({ agent: 'gemini', executable: '/installed/gemini', args, contextFile, env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaults } });
  assert.equal(await readFile(defaults, 'utf8'), original);
  const overlay = JSON.parse(await readFile(gemini.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH, 'utf8'));
  assert.deepEqual(overlay.security, JSON.parse(original).security); assert.ok(overlay.mcpServers.previous);
  await assert.rejects(agentLaunch({ agent: 'opencode', executable: 'opencode', contextFile, env: { OPENCODE_CONFIG_CONTENT: '{damaged' } }));
});

// A pane can only be restarted into the same conversation if rEngine knows which conversation it
// launched. It names one at launch rather than discovering it afterwards, and only for an agent
// whose CLI accepts being told. See docs/specs/096-agent-session-resume.md.
test('rEngine names the conversation it launches and resumes that same one', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-agent-conversation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contextFile = path.join(directory, 'context.json');
  await writeFile(contextFile, JSON.stringify({ rootId: '12345678-1234-1234-1234-123456789abc' }));
  const conversation = '87654321-4321-4321-4321-cba987654321';
  const fresh = await agentLaunch({ agent: 'claude', executable: '/installed/claude', contextFile, env: {}, conversation });
  assert.deepEqual(fresh.args.slice(-2), ['--session-id', conversation], 'a fresh launch tells the CLI which conversation it is');
  assert.equal(fresh.conversation, conversation, 'and the plan reports it so the session record can keep it');
  const resumed = await agentLaunch({ agent: 'claude', executable: '/installed/claude', contextFile, env: {}, conversation, resume: true });
  assert.deepEqual(resumed.args.slice(-2), ['--resume', conversation], 'a restart resumes rather than starting a second conversation');
  const codex = await agentLaunch({ agent: 'codex', executable: '/installed/codex', contextFile, env: {}, conversation });
  assert.equal(codex.conversation, undefined, 'an agent that cannot be told its conversation id is not given a fake one');
  assert.equal(codex.args.includes(conversation), false);
  await assert.rejects(agentLaunch({ agent: 'claude', executable: '/installed/claude', contextFile, env: {}, conversation: 'not-a-uuid' }),
    /conversation/i, 'and an identifier we did not mint is refused');
});
