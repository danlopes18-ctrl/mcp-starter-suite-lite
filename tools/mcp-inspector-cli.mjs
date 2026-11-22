#!/usr/bin/env node
/**
 * Universal Zero-Dependency MCP Stdio Inspector CLI
 * Usage:
 *   node tools/mcp-inspector-cli.mjs <path/to/server.mjs> list
 *   node tools/mcp-inspector-cli.mjs <path/to/server.mjs> call <toolName> '<jsonArgs>'
 */
import {spawn} from 'node:child_process';
import readline from 'node:readline';

const [, , serverPath, action = 'list', toolName, rawArgs = '{}'] = process.argv;
if (!serverPath) {
    console.error('Usage: node mcp-inspector-cli.mjs <server.mjs> [list | call <toolName> <jsonArgs>]');
    process.exit(1);
}

const child = spawn(process.execPath, [serverPath], {stdio: ['pipe', 'pipe', 'inherit']});
const rl = readline.createInterface({input: child.stdout, crlfDelay: Infinity});

const pending = new Map();
let nextId = 1;

rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
        const msg = JSON.parse(trimmed);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        }
    } catch {
        // ignore non-JSON stderr/debug
    }
});

function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Timeout waiting for ${method}`));
        }, 15000);
        pending.set(id, (msg) => {
            clearTimeout(timer);
            resolve(msg);
        });
        child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
    });
}

try {
    const init = await rpc('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'mcp-inspector-cli', version: '1.0.0'}});
    child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
    if (action === 'list') {
        const tools = await rpc('tools/list');
        console.log(JSON.stringify({serverInfo: init.result?.serverInfo, tools: tools.result?.tools}, null, 2));
    } else if (action === 'call') {
        if (!toolName) throw new Error('Missing <toolName> for call action.');
        const args = JSON.parse(rawArgs);
        const res = await rpc('tools/call', {name: toolName, arguments: args});
        console.log(JSON.stringify(res.result, null, 2));
    } else {
        throw new Error(`Unknown action "${action}". Use "list" or "call".`);
    }
} finally {
    child.kill();
}
