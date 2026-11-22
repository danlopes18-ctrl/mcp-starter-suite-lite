#!/usr/bin/env node
/**
 * 03-mcp-git-intelligence — Read-Only Local Git Intelligence MCP Server (Zero Dependencies)
 * Security: Strictly read-only git subcommands executed via execFileSync (zero shell interpolation).
 *
 * Env:
 *   GIT_REPO_PATH — Absolute path to local Git repository (default: process.cwd())
 */
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

const SERVER_INFO = {name: 'mcp-git-intelligence', version: '1.0.0'};
const REPO_PATH = path.resolve(process.env.GIT_REPO_PATH || process.cwd());

function runGit(args) {
    return execFileSync('git', ['-C', REPO_PATH, ...args], {encoding: 'utf8', maxBuffer: 5 * 1024 * 1024}).trim();
}

function assertSafeRef(ref) {
    const val = String(ref ?? '');
    if (!val || val.startsWith('-') || !/^[A-Za-z0-9._/~^-]+$/.test(val)) {
        throw new Error(`Invalid git ref: "${val}"`);
    }
    return val;
}

const TOOLS = [
    {
        name: 'git_status_summary',
        description: 'Get current branch, HEAD commit, upstream status, and modified/untracked files.',
        inputSchema: {type: 'object', properties: {}},
    },
    {
        name: 'git_log_search',
        description: 'Search recent commits optionally filtered by message grep or author.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {type: 'number', description: 'Number of commits 1-50 (default: 15)'},
                grep: {type: 'string', description: 'Optional substring to match in commit messages'},
                author: {type: 'string', description: 'Optional author filter'},
            },
        },
    },
    {
        name: 'git_diff_stats',
        description: 'Show diff --stat between HEAD and working tree or between two git refs.',
        inputSchema: {
            type: 'object',
            properties: {
                baseRef: {type: 'string', description: 'Optional base ref (e.g., HEAD~5 or main)'},
                headRef: {type: 'string', description: 'Optional head ref (default: HEAD)'},
            },
        },
    },
    {
        name: 'git_hotspots',
        description: 'Identify the most frequently changed files across the last N commits.',
        inputSchema: {
            type: 'object',
            properties: {commits: {type: 'number', description: 'Commit window 5-200 (default: 50)'}},
        },
    },
    {
        name: 'git_changelog_draft',
        description: 'Generate a grouped Markdown changelog draft from recent commits.',
        inputSchema: {
            type: 'object',
            properties: {limit: {type: 'number', description: 'Commits to include 1-50 (default: 20)'}},
        },
    },
];

function handleToolCall(name, args = {}) {
    if (name === 'git_status_summary') {
        const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
        const head = runGit(['log', '-1', '--format=%h %s (%ci)']);
        const statusRaw = runGit(['status', '--porcelain']);
        const changedFiles = statusRaw ? statusRaw.split(/\r?\n/).filter(Boolean) : [];
        return {repo: path.basename(REPO_PATH), branch, head, isClean: changedFiles.length === 0, changedCount: changedFiles.length, changedFiles: changedFiles.slice(0, 100)};
    }
    if (name === 'git_log_search') {
        const limit = Math.min(Math.max(Number(args.limit ?? 15), 1), 50);
        const gitArgs = ['log', `-n`, String(limit), '--format=%h\t%ci\t%an\t%s'];
        if (args.grep) gitArgs.push(`--grep=${String(args.grep)}`, '-i');
        if (args.author) gitArgs.push(`--author=${String(args.author)}`);
        const out = runGit(gitArgs);
        const commits = out
            ? out.split(/\r?\n/).map((line) => {
                  const [hash, date, author, ...subj] = line.split('\t');
                  return {hash, date, author, subject: subj.join('\t')};
              })
            : [];
        return {count: commits.length, commits};
    }
    if (name === 'git_diff_stats') {
        if (args.baseRef) {
            const base = assertSafeRef(args.baseRef);
            const head = args.headRef ? assertSafeRef(args.headRef) : 'HEAD';
            return {range: `${base}..${head}`, stat: runGit(['diff', '--stat', `${base}..${head}`]) || '(no diff)'};
        }
        return {scope: 'working-tree', stat: runGit(['diff', '--stat']) || '(clean working tree)'};
    }
    if (name === 'git_hotspots') {
        const n = Math.min(Math.max(Number(args.commits ?? 50), 5), 200);
        const out = runGit(['log', `-n`, String(n), '--name-only', '--pretty=format:']);
        const counts = new Map();
        for (const line of out.split(/\r?\n/)) {
            const f = line.trim();
            if (!f) continue;
            counts.set(f, (counts.get(f) || 0) + 1);
        }
        const top = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([file, touches]) => ({file, touches}));
        return {commitWindow: n, hotspots: top};
    }
    if (name === 'git_changelog_draft') {
        const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 50);
        const out = runGit(['log', `-n`, String(limit), '--format=%h\t%s']);
        const groups = {feat: [], fix: [], perf: [], other: []};
        for (const line of out.split(/\r?\n/).filter(Boolean)) {
            const [hash, ...rest] = line.split('\t');
            const subj = rest.join('\t');
            if (/^feat(\(|:)/i.test(subj)) groups.feat.push(`- ${subj} (\`${hash}\`)`);
            else if (/^fix(\(|:)/i.test(subj)) groups.fix.push(`- ${subj} (\`${hash}\`)`);
            else if (/^perf(\(|:)/i.test(subj)) groups.perf.push(`- ${subj} (\`${hash}\`)`);
            else groups.other.push(`- ${subj} (\`${hash}\`)`);
        }
        const sections = [];
        if (groups.feat.length) sections.push(`### Features\n${groups.feat.join('\n')}`);
        if (groups.fix.length) sections.push(`### Fixes\n${groups.fix.join('\n')}`);
        if (groups.perf.length) sections.push(`### Performance\n${groups.perf.join('\n')}`);
        if (groups.other.length) sections.push(`### Other Changes\n${groups.other.join('\n')}`);
        return {markdown: sections.join('\n\n') || '(no commits found)'};
    }
    throw new Error(`Unknown tool: ${name}`);
}

function send(msg) {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
        req = JSON.parse(trimmed);
    } catch {
        send({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}});
        return;
    }
    const {id, method, params} = req;
    if (method === 'notifications/initialized' || id === undefined) return;
    try {
        if (method === 'initialize') {
            send({jsonrpc: '2.0', id, result: {protocolVersion: '2024-11-05', capabilities: {tools: {}}, serverInfo: SERVER_INFO}});
        } else if (method === 'tools/list') {
            send({jsonrpc: '2.0', id, result: {tools: TOOLS}});
        } else if (method === 'tools/call') {
            const data = handleToolCall(params?.name, params?.arguments);
            send({jsonrpc: '2.0', id, result: {content: [{type: 'text', text: JSON.stringify(data, null, 2)}]}});
        } else if (method === 'ping') {
            send({jsonrpc: '2.0', id, result: {}});
        } else {
            send({jsonrpc: '2.0', id, error: {code: -32601, message: `Method not found: ${method}`}});
        }
    } catch (err) {
        send({jsonrpc: '2.0', id, result: {isError: true, content: [{type: 'text', text: `Error: ${err.message}`}]}});
    }
});
