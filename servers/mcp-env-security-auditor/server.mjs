#!/usr/bin/env node
/**
 * 11-mcp-env-security-auditor — Secret Leak & .env Drift Auditor MCP Server (Zero Dependencies)
 * Security: Never prints full secret values — always returns masked previews + file/line location.
 *
 * Env:
 *   AUDIT_ROOT — Sandboxed repo directory to scan (default: process.cwd())
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const SERVER_INFO = {name: 'mcp-env-security-auditor', version: '1.0.0'};
const AUDIT_ROOT = fs.realpathSync(path.resolve(process.env.AUDIT_ROOT || process.cwd()));
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv']);

const SECRET_RULES = [
    {id: 'AWS_ACCESS_KEY', rx: /\b(AKIA[0-9A-Z]{16})\b/g},
    {id: 'OPENAI_API_KEY', rx: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{24,})\b/g},
    {id: 'GITHUB_PAT', rx: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g},
    {id: 'STRIPE_LIVE_KEY', rx: /\b(sk_live_[A-Za-z0-9]{16,})\b/g},
    {id: 'SLACK_TOKEN', rx: /\b(xox[baprs]-[A-Za-z0-9-]{16,})\b/g},
    {id: 'PRIVATE_KEY_HEADER', rx: /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g},
    {id: 'GOOGLE_API_KEY', rx: /\b(AIza[0-9A-Za-z_-]{35})\b/g},
    {id: 'JWT_TOKEN', rx: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g},
];

function maskValue(val) {
    if (val.length <= 8) return '****';
    return `${val.slice(0, 4)}...${val.slice(-4)}`;
}

function resolveInsideRoot(relPath = '.') {
    const candidate = path.resolve(AUDIT_ROOT, String(relPath ?? '.'));
    const rel = path.relative(AUDIT_ROOT, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path traversal blocked.');
    if (!fs.existsSync(candidate)) throw new Error(`Path not found: "${relPath}"`);
    return fs.realpathSync(candidate);
}

function parseEnvKeys(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const keys = [];
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
        if (m) keys.push(m[1]);
    }
    return [...new Set(keys)];
}

function scanDir(dir, findings = [], maxFindings = 100) {
    if (findings.length >= maxFindings) return findings;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (findings.length >= maxFindings) break;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name)) scanDir(full, findings, maxFindings);
            continue;
        }
        const st = fs.statSync(full);
        if (st.size > 512 * 1024) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes('\0')) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            for (const rule of SECRET_RULES) {
                rule.rx.lastIndex = 0;
                let match;
                while ((match = rule.rx.exec(lines[i])) !== null) {
                    findings.push({
                        rule: rule.id,
                        file: path.relative(AUDIT_ROOT, full).replace(/\\/g, '/'),
                        line: i + 1,
                        maskedPreview: maskValue(match[1]),
                    });
                    if (findings.length >= maxFindings) return findings;
                }
            }
        }
    }
    return findings;
}

const TOOLS = [
    {
        name: 'scan_secrets',
        description: 'Scan workspace text files for leaked API keys/tokens/private keys and report masked findings (never exposes full secrets).',
        inputSchema: {type: 'object', properties: {subpath: {type: 'string', description: 'Optional relative subfolder'}}},
    },
    {
        name: 'audit_env_drift',
        description: 'Compare key names (never values) between .env and .env.example to catch missing or undocumented env vars.',
        inputSchema: {
            type: 'object',
            properties: {
                envFile: {type: 'string', description: 'Default: ".env"'},
                exampleFile: {type: 'string', description: 'Default: ".env.example"'},
            },
        },
    },
    {
        name: 'check_gitignore_hygiene',
        description: 'Check if .gitignore properly ignores .env, *.pem, *.key, and node_modules.',
        inputSchema: {type: 'object', properties: {}},
    },
];

function handleToolCall(name, args = {}) {
    if (name === 'scan_secrets') {
        const target = resolveInsideRoot(args.subpath || '.');
        const findings = scanDir(target);
        return {scannedRoot: path.basename(target), findingCount: findings.length, clean: findings.length === 0, findings};
    }
    if (name === 'audit_env_drift') {
        const envPath = path.resolve(AUDIT_ROOT, String(args.envFile || '.env'));
        const exPath = path.resolve(AUDIT_ROOT, String(args.exampleFile || '.env.example'));
        const envKeys = parseEnvKeys(envPath);
        const exKeys = parseEnvKeys(exPath);
        const envSet = new Set(envKeys);
        const exSet = new Set(exKeys);
        return {
            envKeyCount: envKeys.length,
            exampleKeyCount: exKeys.length,
            missingInEnv: exKeys.filter((k) => !envSet.has(k)),
            undocumentedInExample: envKeys.filter((k) => !exSet.has(k)),
        };
    }
    if (name === 'check_gitignore_hygiene') {
        const giPath = path.join(AUDIT_ROOT, '.gitignore');
        if (!fs.existsSync(giPath)) {
            return {exists: false, missingRecommendedRules: ['.env', '.env.*', '*.pem', '*.key', 'node_modules']};
        }
        const lines = fs.readFileSync(giPath, 'utf8').split(/\r?\n/).map((l) => l.trim());
        const required = ['.env', '*.pem', '*.key', 'node_modules'];
        const missing = required.filter((r) => !lines.some((l) => l === r || l.includes(r)));
        return {exists: true, healthy: missing.length === 0, missingRecommendedRules: missing};
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
