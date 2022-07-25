let apiCB = {};
let functionRef = {};

export function verifyPlugin(allow) {
    process.send({
        op: "verifyPlugin",
        allow: allow
    });
}

export async function callFuncPlugin(namespace, funcName, ...args) {
    let nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    process.send({
        op: "callFuncPlugin",
        namespace,
        funcName,
        args,
        nonce
    });

    let rtData = await new Promise(resolve => {
        apiCB[nonce] = resolve;
    });

    if (rtData.error) {
        throw rtData.error;
    }

    return rtData.data;
}

export async function registerFuncPlugin(funcName, callback) {
    if (functionRef[funcName]) {
        throw new Error(`Function ${funcName} already registered`);
    }

    functionRef[funcName] = callback;
    return true;
}

export async function callAPI(moduleID, cmd, value) {
    let nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    process.send({
        op: "callAPI",
        moduleID,
        cmd,
        value,
        nonce
    });

    let rtData = await new Promise(resolve => {
        apiCB[nonce] = resolve;
    });

    if (rtData.error) {
        throw rtData.error;
    }

    return rtData.data;
}

export async function registerCommand(commandName, commandDescAPI, commandCallback, compatibility) {
    let nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    process.send({
        op: "registerCommand",
        compatibility,
        commandName,
        commandDescAPI,
        commandCallback,
        nonce
    });

    let rtData = await new Promise(resolve => {
        apiCB[nonce] = resolve;
    });

    return rtData.success;
}

export async function registerCommandFuncPlugin(commandName, funcDescAPI, funcName, compatibility) {
    let nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    process.send({
        op: "registerCommandFuncPlugin",
        compatibility,
        commandName,
        funcDescAPI,
        funcName,
        nonce
    });

    let rtData = await new Promise(resolve => {
        apiCB[nonce] = resolve;
    });

    return rtData.success;
}

export function exit(exit_code, exit_reason) {
    process.send({
        op: "exit",
        exit_code,
        exit_reason
    });

    process.exit(exit_code);
}

export function waitForModule(moduleNamespace, timeout) {
    let nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    process.send({
        op: "waitForModule",
        moduleNamespace
    });

    let rtData = await new Promise(resolve => {
        apiCB[nonce] = resolve;
    });

    return rtData.success;
}

function log(level, ...args) {
    process.send({
        op: "log",
        level,
        args
    });
}

export const log = {
    critical: (...args) => log("critical", ...args),
    error: (...args) => log("error", ...args),
    warn: (...args) => log("warn", ...args),
    info: (...args) => log("info", ...args),
    debug: (...args) => log("debug", ...args),
    verbose: (...args) => log("verbose", ...args)
}

process.on("message", (msg) => {
    if (msg.op = "cb") {
        apiCB[msg.nonce]?.(msg.data);
    }
});
