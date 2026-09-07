/* A language server that exists to be talked to, not to analyse anything. It speaks the protocol
   honestly — Content-Length framing, initialize/initialized, didOpen/didChange/didClose,
   publishDiagnostics — and reports one diagnostic per line containing the word it was given, so a
   test can change a buffer and watch the answer change.

   Arguments: --word WORD (default TODO), --crash-after N (exit non-zero after N opens),
   --slow-initialize MS. */
import { framer } from '../runtime/lsp.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const WORD = option('--word', 'TODO');
const CRASH_AFTER = Number(option('--crash-after', 0));
const SLOW = Number(option('--slow-initialize', 0));

const send = message => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};

const documents = new Map();
let opens = 0;

const publish = uri => {
  const text = documents.get(uri) ?? '';
  const items = text.split('\n').flatMap((line, number) => {
    const at = line.indexOf(WORD);
    if (at < 0) return [];
    return [{
      range: { start: { line: number, character: at }, end: { line: number, character: at + WORD.length } },
      severity: 2, source: 'fake', message: `${WORD} on line ${number + 1}`,
    }];
  });
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: items } });
};

process.stdin.on('data', framer(async message => {
  if (message.method === 'initialize') {
    if (SLOW) await new Promise(resolve => setTimeout(resolve, SLOW));
    send({ id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  if (message.method === 'shutdown') { send({ id: message.id, result: null }); return; }
  if (message.method === 'exit') process.exit(0);
  if (message.method === 'textDocument/didOpen') {
    documents.set(message.params.textDocument.uri, message.params.textDocument.text);
    publish(message.params.textDocument.uri);
    /* Exit only once the diagnostic has actually left: stdout to a pipe is asynchronous, and a
       process.exit here would swallow the very message the test is waiting for. */
    if (CRASH_AFTER && ++opens >= CRASH_AFTER) process.stdout.write('', () => process.exit(3));
    return;
  }
  if (message.method === 'textDocument/didChange') {
    documents.set(message.params.textDocument.uri, message.params.contentChanges.at(-1).text);
    publish(message.params.textDocument.uri);
    return;
  }
  if (message.method === 'textDocument/didClose') documents.delete(message.params.textDocument.uri);
}));
