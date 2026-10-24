#!/usr/bin/env node
// A stand-in for gh: it records every call and answers from a config file.
// UNTANGLE_GH_LOG is a JSON-lines file; UNTANGLE_GH_CONFIG is { replies: [...] }.
// A reply matches when `match` is a prefix of the arguments. `gh pr view` with no
// reply exits as "no pull request". Anything else fails, and nothing uses the network.
import fs from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString('utf8');
const args = process.argv.slice(2);

const log = process.env.UNTANGLE_GH_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args, stdin }) + '\n');

let replies = [];
const configPath = process.env.UNTANGLE_GH_CONFIG;
if (configPath && fs.existsSync(configPath)) {
  replies = JSON.parse(fs.readFileSync(configPath, 'utf8')).replies ?? [];
}

const matched = replies.find((reply) => {
  const argsMatch = (reply.match ?? []).every((part, index) => args[index] === part);
  return argsMatch && (reply.stdinIncludes == null || stdin.includes(reply.stdinIncludes));
});
if (matched) {
  if (matched.stdout) process.stdout.write(matched.stdout);
  if (matched.stderr) process.stderr.write(matched.stderr);
  process.exit(matched.code ?? 0);
}

if (args[0] === 'pr' && args[1] === 'view') {
  process.stderr.write('no pull request\n');
  process.exit(1);
}

if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write('[]\n');
  process.exit(0);
}

process.stderr.write(`gh stub: no reply for: ${args.join(' ')}\n`);
process.exit(1);
