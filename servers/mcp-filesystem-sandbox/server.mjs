#!/usr/bin/env node
/**
 * 02-mcp-filesystem-sandbox — Path-Jailed Workspace MCP Server (Zero Dependencies)
 * Security: Strict root jail (realpath symlink verification) + blocks .env, private keys & secrets.
 *
 * Env:
 *   SANDBOX_ROOT — Absolute workspace root directory (default: process.cwd())
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const SERVER_INFO = {name: 'mcp-filesystem-sandbox', version: '1.0.0'};
const ROOT = fs.realpathSync(path.resolve(process.env.SANDBOX_ROOT || process.cwd()));
const BLOCKED_NAMES = [/(^|\.)env(\.|$)/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /^id_rsa/i, /^id_ed25519/i, /credentials\.json$/i, /\.npmrc$/i, /\.netrc$/i];
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv']);

function isSensitive(filePath) {
    const base = path.basename(filePath);
    return BLOCKED_NAMES.some((rx) => rx.test(base));
}

function resolveSafePath(relPath = '.') {
    const raw = String(relPath ?? '.');
    if (raw.includes('\0')) {
        throw new Error('Null byte in path is forbidden.');
    }
    const candidate = path.resolve(ROOT, raw);
    const relFromRoot = path.relative(ROOT, candidate);
    if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
        throw new Error(`Path traversal blocked: "${raw}" escapes sandbox root.`);
    }
    if (!fs.existsSync(candidate)) {
        throw new Error(`Path not found: "${raw}"`);
    }
    const real = fs.realpathSync(candidate);
    const realRel = path.relative(ROOT, real);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw new Error(`Symlink escape blocked: "${raw}" points outside sandbox root.`);
    }
    if (isSensitive(real)) {
        throw new Error(`Access blocked to sensitive file: "${path.basename(real)}"`);
    }
    return real;
}

function listTree(dir, maxDepth, currentDepth = 0, out = []) {
    if (currentDepth > maxDepth || out.length >= 400) return out;
    const entries = fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        if (out.length >= 400) break;
        if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (isSensitive(full)) continue;
        const rel = path.relative(ROOT, full).replace(/\\/g, '/');
        out.push({path: rel, type: entry.isDirectory() ? 'dir' : 'file'});
        if (entry.isDirectory() && currentDepth < maxDepth) {
            listTree(full, maxDepth, currentDepth + 1, out);
        }
    }
    return out;
}

function searchText(dir, query, maxMatches = 50, matches = []) {
    if (matches.length >= maxMatches) return matches;
    const entries = fs.readdirSync(dir, {withFileTypes: true});
    const lowerQ = query.toLowerCase();
    for (const entry of entries) {
        if (matches.length >= maxMatches) break;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name)) searchText(full, query, maxMatches, matches);
            continue;
        }
        if (isSensitive(full)) continue;
        const st = fs.statSync(full);
        if (st.size > 512 * 1024) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes('\0')) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(lowerQ)) {
                matches.push({
                    file: path.relative(ROOT, full).replace(/\\/g, '/'),
                    line: i + 1,
                    preview: lines[i].trim().slice(0, 180),
                });
                if (matches.length >= maxMatches) break;
            }
        }
    }
    return matches;
}

const TOOLS = [
    {
        name: 'list_tree',
        description: 'List files and directories inside the sandboxed workspace (skips secrets, .git, node_modules).',
        inputSchema: {
            type: 'object',
            properties: {
                subpath: {type: 'string', description: 'Relative directory path (default: ".")'},
                maxDepth: {type: 'number', description: 'Max recursion depth 0-5 (default: 2)'},
            },
        },
    },
    {
        name: 'read_file_range',
        description: 'Read a line range from a file inside the sandboxed workspace.',
        inputSchema: {
            type: 'object',
            properties: {
                path: {type: 'string', description: 'Relative file path'},
                startLine: {type: 'number', description: '1-based start line (default: 1)'},
                endLine: {type: 'number', description: '1-based inclusive end line (default: 200)'},
            },
            required: ['path'],
        },
    },
    {
        name: 'search_text',
        description: 'Case-insensitive text search across non-secret text files inside the sandbox.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {type: 'string', description: 'Substring to search for'},
                subpath: {type: 'string', description: 'Optional relative subfolder'},
                maxMatches: {type: 'number', description: 'Max matches 1-100 (default: 30)'},
            },
            required: ['query'],
        },
    },
    {
        name: 'file_stats',
        description: 'Return size, line count, and modified timestamp for a file inside the sandbox.',
        inputSchema: {
            type: 'object',
            properties: {path: {type: 'string', description: 'Relative file path'}},
            required: ['path'],
        },
    },
];

function handleToolCall(name, args = {}) {
    if (name === 'list_tree') {
        const target = resolveSafePath(args.subpath || '.');
        const depth = Math.min(Math.max(Number(args.maxDepth ?? 2), 0), 5);
        const items = listTree(target, depth);
        return {root: path.basename(ROOT), count: items.length, items};
    }
    if (name === 'read_file_range') {
        const target = resolveSafePath(args.path);
        const stat = fs.statSync(target);
        if (!stat.isFile()) throw new Error('Target is not a regular file.');
        if (stat.size > 2 * 1024 * 1024) throw new Error('File exceeds 2MB safety cap.');
        const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
        const start = Math.max(1, Number(args.startLine ?? 1));
        const end = Math.min(lines.length, Math.max(start, Number(args.endLine ?? start + 199)));
        return {
            file: path.relative(ROOT, target).replace(/\\/g, '/'),
            totalLines: lines.length,
            startLine: start,
            endLine: end,
            content: lines.slice(start - 1, end).map((l, idx) => `${start + idx}: ${l}`).join('\n'),
        };
    }
    if (name === 'search_text') {
        const q = String(args.query ?? '');
        if (!q.trim()) throw new Error('Query cannot be empty.');
        const target = resolveSafePath(args.subpath || '.');
        const cap = Math.min(Math.max(Number(args.maxMatches ?? 30), 1), 100);
        const matches = searchText(target, q, cap);
        return {query: q, matchCount: matches.length, matches};
    }
    if (name === 'file_stats') {
        const target = resolveSafePath(args.path);
        const stat = fs.statSync(target);
        const lineCount = stat.isFile() && stat.size <= 2 * 1024 * 1024 ? fs.readFileSync(target, 'utf8').split(/\r?\n/).length : null;
        return {
            file: path.relative(ROOT, target).replace(/\\/g, '/'),
            isFile: stat.isFile(),
            sizeBytes: stat.size,
            lineCount,
            modifiedAt: stat.mtime.toISOString(),
        };
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
