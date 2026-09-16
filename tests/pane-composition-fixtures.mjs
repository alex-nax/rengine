/* The frozen record of what sessions.mjs's agentPaneComposition answered, captured on 2026-09-13
 * from the module itself, immediately before F178 deleted it. The Rust composition is now the only
 * implementation; a record regenerated from the replacement would be judging it against itself, so
 * this file is never regenerated — the same discipline agents-fixtures.mjs and
 * report-session-fixtures.json follow.
 *
 * The fixtures themselves (paths, remembered list, cases) are F168's, moved here unchanged so the
 * test and the record cannot drift apart.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PATHS = {
  agentScript: '/repo/actions/pane/posix/agent.sh',
  rootPath: '/work/project',
  workspaceContextFile: '/state/integrations/12345678-1234-1234-1234-123456789abc.json',
  listingFile: '/state/integrations/00000000-0000-0000-0000-0000000000aa.conversations.tsv',
  node: '/usr/local/bin/node',
  bash: '/bin/bash',
};
export const SID = '00000000-0000-0000-0000-0000000000aa';
export const MINT = '11111111-2222-3333-4444-555555555555';
export const KIMI_ID = 'session_3f85774e-05bb-4791-bb9f-1c90dc37d0e6';
export const UUID = '3f85774e-05bb-4791-bb9f-1c90dc37d0e6';
export const NOW = 1_800_000_000_000;
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

export const REMEMBERED = [
  { id: UUID, agent: 'codex', lastSeenAt: NOW - 30 * 1000 },        // just now
  { id: 'aaaaaaaa-0000-0000-0000-000000000001', agent: 'claude', lastSeenAt: NOW - 45 * MINUTE },
  { id: 'aaaaaaaa-0000-0000-0000-000000000002', agent: 'kimi', lastSeenAt: NOW - 90 * MINUTE },  // an hour ago
  { id: 'aaaaaaaa-0000-0000-0000-000000000003', agent: '', lastSeenAt: NOW - 5 * HOUR },
  { id: 'aaaaaaaa-0000-0000-0000-000000000004', agent: 'claude', lastSeenAt: NOW - 30 * HOUR },  // yesterday
  { id: 'aaaaaaaa-0000-0000-0000-000000000005', agent: 'codex', lastSeenAt: NOW - 5 * DAY },
];

export const pane = fields => ({
  id: SID, agent: null, conversation: null, resume: false, action: 'launch', args: [],
  workspace: true, remembered: REMEMBERED, mint: MINT, now: NOW, paths: PATHS, ...fields,
});

export const CASES = [
  ['claude mints for a bare workspace pane and offers the project history', pane({ agent: 'claude' })],
  ['claude with trailing args still mints, and is offered nothing', pane({ agent: 'claude', args: ['--model', 'claude-opus-5'] })],
  ['kimi names its own on a bare pane: nothing minted, the history still offered', pane({ agent: 'kimi' })],
  ['kimi refuses a named conversation without resume, in its own words', pane({ agent: 'kimi', conversation: KIMI_ID })],
  ['kimi resumes a recorded conversation, which leaves the offered list', pane({ agent: 'kimi', conversation: KIMI_ID, resume: true })],
  ['codex resumes a recorded conversation', pane({ agent: 'codex', conversation: UUID, resume: true })],
  ['codex on a bare pane mints nothing', pane({ agent: 'codex' })],
  ['gemini has no conversation capability and is not refused for one named', pane({ agent: 'gemini', conversation: UUID })],
  ['an unknown agent is not refused either', pane({ agent: 'testcli', conversation: UUID })],
  ['without a workspace only argv is composed, and no conversation is claimed', pane({ agent: 'claude', conversation: UUID, workspace: false })],
  ['claude resumes when asked', pane({ agent: 'claude', conversation: UUID, resume: true })],
  ['the offered list never contains the conversation the pane just took', pane({ agent: 'claude',
    remembered: [{ id: MINT, agent: 'claude', lastSeenAt: NOW - 30 * 1000 }, ...REMEMBERED] })],
];

export const RECORDED = JSON.parse(await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'pane-composition-fixtures.json'), 'utf8'));
