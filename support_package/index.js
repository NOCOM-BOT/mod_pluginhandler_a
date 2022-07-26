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

    let rtData = await new Promise((resolve, reject) => {
        apiCB[nonce] = {
            resolve, reject
        };
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

    let randomFuncNameCallback = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let randomFuncNameDescAPI = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    functionRef[randomFuncNameCallback] = commandCallback;
    functionRef[randomFuncNameDescAPI] = commandDescAPI;

    process.send({
        op: "registerCommand",
        compatibility,
        funcName: randomFuncNameCallback,
        funcDescAPI: randomFuncNameDescAPI,
        commandName,
        nonce
    });

    let rtData = await new Promise((resolve, reject) => {
        apiCB[nonce] = {
            resolve, reject
        };
    });

    return rtData.success;
}

export async function registerCommandFuncPlugin(commandName, funcDescAPI, funcName, compatibility) {
    let nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    process.send({
        op: "registerCommand",
        compatibility,
        commandName,
        funcDescAPI,
        funcName,
        nonce
    });

    let rtData = await new Promise((resolve, reject) => {
        apiCB[nonce] = {
            resolve, reject
        };
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

export async function waitForModule(moduleNamespace, timeout) {
    let nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    process.send({
        op: "waitForModule",
        moduleNamespace,
        timeout
    });

    let rtData = await new Promise((resolve, reject) => {
        apiCB[nonce] = {
            resolve, reject
        };
    });

    return rtData.success;
}

function logger(level, ...args) {
    process.send({
        op: "log",
        level,
        args
    });
}

export const log = {
    critical: (...args) => logger("critical", ...args),
    error: (...args) => logger("error", ...args),
    warn: (...args) => logger("warn", ...args),
    info: (...args) => logger("info", ...args),
    debug: (...args) => logger("debug", ...args),
    verbose: (...args) => logger("verbose", ...args)
}

process.on("message", async (msg) => {
    if (msg.op === "cb") {
        if (msg.error) {
            apiCB[msg.nonce]?.reject?.(msg.error);
        } else {
            apiCB[msg.nonce]?.resolve?.(msg.data);
        }
    }

    if (msg.op === "api_call") {
        let func = functionRef[msg.funcName];
        if (func) {
            try {
                let d = await func(...msg.args);

                process.send({
                    op: "cb",
                    nonce: msg.nonce,
                    data: d
                });
            } catch (e) {
                process.send({
                    op: "cb",
                    nonce: msg.nonce,
                    error: e instanceof Error ? e.stack : String(e)
                });
            }
        } else {
            process.send({
                op: "cb",
                nonce: msg.nonce,
                error: `Function ${msg.funcName} not found`
            });
        }
    }
});
