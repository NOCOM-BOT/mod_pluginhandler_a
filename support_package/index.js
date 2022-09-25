import { serialize, deserialize } from "node:v8";

const MAGIC_HEADER = "PHANDLERA_TRANSMISSION".split("").map((c) => c.charCodeAt(0));

let apiCB = {};
let functionRef = {};

let sendData = process?.send ?? ((data) => {
    let buf = serialize(data);
    let lenBytes = Buffer.alloc(4);
    lenBytes.writeUInt32BE(buf.length, 0);

    process.stderr.write(Buffer.from([
        ...MAGIC_HEADER,
        ...lenBytes,
        ...buf
    ]));
});

export function verifyPlugin(allow) {
    sendData({
        op: "verifyPlugin",
        allow: allow
    });
}

export async function callFuncPlugin(namespace, funcName, ...args) {
    let nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    sendData({
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

    sendData({
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

export async function registerCommand(commandName, commandInfo, commandCallback, compatibility) {
    let nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    let randomFuncNameCallback = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    functionRef[randomFuncNameCallback] = commandCallback;

    sendData({
        op: "registerCommand",
        compatibility,
        funcName: randomFuncNameCallback,
        commandInfo,
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

export async function registerCommandFuncPlugin(commandName, commandInfo, funcName, compatibility) {
    let nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    sendData({
        op: "registerCommand",
        compatibility,
        funcName,
        commandInfo,
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

export function exit(exit_code, exit_reason) {
    sendData({
        op: "exit",
        exit_code,
        exit_reason
    });

    process.exit(exit_code);
}

export async function waitForModule(moduleNamespace, timeout) {
    let nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    sendData({
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
    sendData({
        op: "log",
        level,
        args
    });
}

export function database(databaseID) {
    function q(t, a1, a2, a3) {
        let nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

        sendData({
            op: "database",
            t,
            a1,
            a2,
            a3,
            databaseID
        });

        return new Promise((resolve, reject) => {
            apiCB[nonce] = {
                resolve, reject
            };
        });
    }

    return {
        get: (table, key) => q("get", table, key),
        set: (table, key, value) => q("set", table, key, value),
        delete: (table, key) => q("delete", table, key),
        deleteTable: (table) => q("deleteTable", table)
    }
}

export const log = {
    critical: (...args) => logger("critical", ...args),
    error: (...args) => logger("error", ...args),
    warn: (...args) => logger("warn", ...args),
    info: (...args) => logger("info", ...args),
    debug: (...args) => logger("debug", ...args),
    verbose: (...args) => logger("verbose", ...args)
}

async function handleMessage(msg) {
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

                sendData({
                    op: "cb",
                    nonce: msg.nonce,
                    data: d
                });
            } catch (e) {
                sendData({
                    op: "cb",
                    nonce: msg.nonce,
                    error: e instanceof Error ? e.stack : String(e)
                });
            }
        } else {
            sendData({
                op: "cb",
                nonce: msg.nonce,
                error: `Function ${msg.funcName} not found`
            });
        }
    }
};

process.on("message", handleMessage);

// Parse data from STDIN
// Format of data is: PHANDLERA_TRANSMISSION<length><v8 serialized data>
// PHANDLERA_TRANSMISSION is the magic header
// Length is the length of the msgpack data, in 4 bytes unsigned big-endian integer
//
// Data could be fragmented (including header), so we need to store the data in a buffer
let dataBuffer = [];
let magicHeaderCorrect = 0;
let lastMessageLength = -1;

let isReading = false;
process.stdin.on("data", (dataUnk) => {
    if (this.child?.killed) return;

    let data = Buffer.from(dataUnk);
    // Iterate through the data and check for magic header

    for (let i = 0; i < data.length; i++) {
        if (isReading) {
            // Dump data into buffer
            dataBuffer.push(data[i]);

            // Check if we have length bytes
            if (dataBuffer.length >= MAGIC_HEADER.length + 4) {
                // Read length, but only once
                if (lastMessageLength === -1) {
                    lastMessageLength = Buffer.from(
                        dataBuffer.slice(MAGIC_HEADER.length, MAGIC_HEADER.length + 4)
                    ).readUint32BE(0);
                }

                // Check if we have enough data
                if (dataBuffer.length >= MAGIC_HEADER.length + 4 + lastMessageLength) {
                    // We have enough data, decode it
                    let msgpackData = Buffer.from(
                        dataBuffer.slice(MAGIC_HEADER.length + 4, MAGIC_HEADER.length + 4 + lastMessageLength)
                    );
                    let decoded = deserialize(msgpackData);
                    handleMessage(decoded);

                    // Reset buffer
                    dataBuffer = [];
                    lastMessageLength = -1;
                    isReading = false;
                }
            }
        }

        if (data[i] === MAGIC_HEADER[magicHeaderCorrect]) {
            magicHeaderCorrect++;

            if (magicHeaderCorrect === MAGIC_HEADER.length) {
                // Add header to data buffer
                dataBuffer.push(...MAGIC_HEADER);

                isReading = true;
            }
        } else if (!isReading) {
            magicHeaderCorrect = 0;
        }
    }
});
