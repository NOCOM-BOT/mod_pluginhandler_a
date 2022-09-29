import { fork, spawn } from 'node:child_process';
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type CMComm from "./CMC.js";
import type Logger from "./Logger.js";
import { fileURLToPath, pathToFileURL } from 'url';
import crypto from "node:crypto";
import { serialize, deserialize } from "node:v8";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUPPORT_PACKAGE_LOCATION = path.resolve(__dirname, "..", "support_package");
const TSNODE_BIN_LOCATION = path.resolve(__dirname, "..", "node_modules", "ts-node", "dist", "bin-esm.js");

interface PJSON {
    formatVersion: number,
    pluginName: string,
    pluginNamespace: string,
    pluginVersion: string,
    entryPoint: string,
    author: string,
    subclass: number
    [x: string]: any
}

export default class Plugin {
    apiCBTable: {
        [x: string]: {
            reject: (error: any) => void,
            resolve: (data: any) => void
        }
    } = {};

    started: boolean = false;
    path: string;
    child?: ChildProcess;
    cmc: CMComm;
    logger: Logger;

    pJSON?: PJSON;

    ipcSend?: (data: any) => void;

    constructor(path: string, cmc: CMComm, logger: Logger) {
        this.path = path;
        this.cmc = cmc;
        this.logger = logger;
    }

    async start() {
        if (this.started) {
            return;
        }

        // Read package.json
        let pJSONBase: any;
        let pJSON: PJSON;
        try {
            pJSONBase = JSON.parse(await fs.readFile(path.join(this.path, "package.json"), { encoding: "utf8" }));
            pJSON = pJSONBase.NOCOM_AType_Metadata;
        } catch (e) {
            throw new Error("Invalid metadata");
        }

        if (pJSON.formatVersion !== 1) {
            throw new Error("Invalid metadata");
        }

        if (!pJSON.entryPoint) {
            throw new Error("Invalid metadata");
        }

        // Test for subclass first!
        if (pJSON.subclass !== 0 && pJSON.subclass !== 1) {
            throw new Error("Invalid metadata");
        }

        this.pJSON = pJSON;

        // Add support package
        // PNPM handle things kinda slowly and weirdly, so we need to check if support package
        // is installed first
        // THIS THING TOOK ME 3+ HOURS TO FIGURE OUT
        let supportPackagePath = path.join(this.path, "node_modules", "@nocom_bot", "nocom-atype-support");
        let loadAttempt = 20;
        for (; ;) {
            if (loadAttempt >= 20) {
                await this.cmc.callAPI("core", "pnpm_install_specific", {
                    path: this.path,
                    dep: SUPPORT_PACKAGE_LOCATION
                });
                loadAttempt = 0;
            }

            // Check for support package every 100ms
            await new Promise(resolve => setTimeout(resolve, 100));
            try {
                // Test import index.js
                await import(pathToFileURL(path.join(supportPackagePath, "index.js")).toString());
                // Test package.json
                JSON.parse(await fs.readFile(path.join(supportPackagePath, "package.json"), { encoding: "utf8" }));
                break;
            } catch {
                loadAttempt++;
            }
        }

        // Package download
        await this.cmc.callAPI("core", "pnpm_install", {
            path: this.path
        });

        if (pJSON.subclass === 0) {
            this.child = fork(path.join(this.path, pJSON.entryPoint), [], {
                cwd: path.resolve(this.path),
                stdio: ["pipe", "inherit", "pipe", "ipc"]
            });
        } else if (pJSON.subclass === 1) {
            this.child = spawn(process.execPath, [TSNODE_BIN_LOCATION, path.join(this.path, pJSON.entryPoint)], {
                cwd: path.resolve(this.path),
                stdio: ["pipe", "inherit", "pipe"]
            });
        }

        try {
            await this.handleChild();
        } catch (e) {
            this.child?.kill();
            throw e;
        }
    }

    async stop() {
        if (!this.started) {
            return;
        }

        if (this.child) {
            this.child.kill();
        }
    }

    forceStop() {
        this.child?.kill();
    }

    call(funcName: string, args: any[]) {
        if (!this.started) {
            throw new Error("Plugin not started");
        }

        if (!this.child) {
            throw new Error("Plugin not started");
        }

        let nonce = crypto.randomBytes(16).toString("hex");
        let resolve = (value: any) => { }, reject = (error: any) => { },
            promise = new Promise<any>((r, j) => {
                resolve = r;
                reject = j;
            });

        this.apiCBTable[nonce] = {
            resolve,
            reject
        };

        this.ipcSend?.({
            op: "api_call",
            funcName,
            args,
            nonce
        });

        return promise;
    }

    async handleChild() {
        if (this.child) {
            let res: () => void, rej: (e: any) => void, promise = new Promise<void>((resolve, reject) => {
                res = resolve; rej = reject;
                setTimeout(() => reject(new Error("Timeout")), 30000);
            });

            this.child.on("error", () => {
                rej(new Error("Child process error"));
            });

            let handleMessage = async (message: any, send?: Function) => {
                switch (message.op) {
                    case "verifyPlugin":
                        if (!message.allow) {
                            this.child?.kill();
                            this.child = undefined;
                            rej(new Error("DRM triggered"));
                        } else {
                            res();
                        }
                        break;

                    case "callFuncPlugin":
                        // Find the module responsible for the namespace
                        let req1 = await this.cmc.callAPI("core", "get_plugin_namespace_info", {
                            namespace: message.namespace
                        });

                        if (req1.exist) {
                            if (req1.data.exist) {
                                let resolverID = req1.data.resolver as string;
                                let req2 = await this.cmc.callAPI(resolverID, "plugin_call", {
                                    namespace: message.namespace,
                                    funcName: message.funcName,
                                    args: message.args
                                });

                                if (req2.exist) {
                                    send?.({
                                        op: "cb",
                                        nonce: message.nonce,
                                        data: req2.data.returnData,
                                        error: req2.data.error
                                    });
                                } else {
                                    send?.({
                                        op: "cb",
                                        nonce: message.nonce,
                                        error: "Module resolver failed"
                                    });
                                }
                            } else {
                                send?.({
                                    op: "cb",
                                    nonce: message.nonce,
                                    error: "Namespace not found"
                                });
                            }
                        } else {
                            send?.({
                                op: "cb",
                                nonce: message.nonce,
                                error: "Incompatible core/kernel (???)"
                            });
                        }
                        break;

                    case "callAPI":
                        let req3 = await this.cmc.callAPI(message.moduleID, message.cmd, message.value);
                        if (req3.exist) {
                            send?.({
                                op: "cb",
                                nonce: message.nonce,
                                error: req3.error,
                                data: req3.data
                            });
                        } else {
                            send?.({
                                op: "cb",
                                nonce: message.nonce,
                                error: "Function not found"
                            });
                        }
                        break;

                    case "registerCommand":
                        // Find command resolver
                        // Get every module first
                        let req4 = await this.cmc.callAPI("core", "get_registered_modules", {});
                        if (req4.exist) {
                            for (let module of req4.data) {
                                let typedModule = module as {
                                    moduleID: string,
                                    type: string,
                                    namespace: string,
                                    displayname: string,
                                    running: boolean
                                };

                                if (typedModule.type === "cmd_handler") {
                                    if (!typedModule.running) {
                                        let reqTO = await this.cmc.callAPI("core", "wait_for_module", {
                                            moduleNamespace: typedModule.namespace,
                                            timeout: 10000
                                        });

                                        if (!reqTO.exist || (reqTO.exist && !reqTO.data)) {
                                            continue;
                                        }
                                    }

                                    let req5 = await this.cmc.callAPI(typedModule.moduleID, "register_cmd", {
                                        namespace: this.pJSON?.pluginNamespace,
                                        command: message.commandName,
                                        funcName: message.funcName,
                                        description: message.commandInfo?.description ?? { fallback: "" },
                                        args: message.commandInfo?.args ?? { fallback: "" },
                                        argsName: message.commandInfo?.argsName ?? { fallback: "" },
                                        compatibility: message.compatibility ?? [],
                                    });

                                    if (req5.exist) {
                                        send?.({
                                            op: "cb",
                                            nonce: message.nonce,
                                            error: req5.data?.error ?? req5.error,
                                            data: {
                                                success: req5.data?.success ?? false
                                            }
                                        });
                                        return;
                                    } else {
                                        continue;
                                    }
                                } else {
                                    continue;
                                }
                            }

                            send?.({
                                op: "cb",
                                nonce: message.nonce,
                                error: "Command handler is not installed"
                            });
                        } else {
                            send?.({
                                op: "cb",
                                nonce: message.nonce,
                                error: "Incompatible core/kernel (???)"
                            });
                        }
                        break;

                    case "exit":
                        await this.cmc.callAPI("core", "unregister_plugin", {
                            namespace: this.pJSON?.pluginNamespace
                        });
                        break;

                    case "waitForModule":
                        let req6 = await this.cmc.callAPI("core", "wait_for_module", {
                            moduleNamespace: message.moduleNamespace,
                            timeout: message.timeout
                        });

                        if (req6.exist) {
                            send?.({
                                op: "cb",
                                nonce: message.nonce,
                                error: req6.error,
                                data: {
                                    success: req6.data?.success ?? false
                                }
                            });
                        } else {
                            send?.({
                                op: "cb",
                                nonce: message.nonce,
                                data: {
                                    success: false
                                }
                            });
                        }
                        break;

                    case "log":
                        //@ts-ignore
                        this.logger[message.level]?.(`phandler_A[${this.pJSON?.pluginNamespace}]`, ...message.args);
                        break;

                    case "cb":
                        if (this.apiCBTable[message.nonce]) {
                            if (message.error) {
                                this.apiCBTable[message.nonce].reject(message.error);
                            } else {
                                this.apiCBTable[message.nonce].resolve(message.data);
                            }
                            delete this.apiCBTable[message.nonce];
                        }
                        break;

                    case "database":
                        // Get database resolver for the corresponding database ID
                        let req7 = await this.cmc.callAPI("core", "get_db_resolver", {
                            databaseID: message.databaseID
                        });
                        if (req7.exist) {
                            if (!req7.error) {
                                let resolverID = req7.data.resolver;

                                switch (message.t) {
                                    case "get":
                                        let req8 = await this.cmc.callAPI(resolverID, "get_data", {
                                            databaseID: message.databaseID,
                                            table: message.a1,
                                            key: message.a2
                                        });
                                        if (req8.exist) {
                                            send?.({
                                                op: "cb",
                                                nonce: message.nonce,
                                                data: req8.data
                                            });
                                        } else {
                                            send?.({
                                                op: "cb",
                                                nonce: message.nonce,
                                                error: "Database not found"
                                            });
                                        }
                                        break;
                                    case "set":
                                        let req9 = await this.cmc.callAPI(resolverID, "set_data", {
                                            databaseID: message.databaseID,
                                            table: message.a1,
                                            key: message.a2,
                                            value: message.a3
                                        });
                                        if (req9.exist) {
                                            send?.({
                                                op: "cb",
                                                nonce: message.nonce,
                                                data: true
                                            });
                                        } else {
                                            send?.({
                                                op: "cb",
                                                nonce: message.nonce,
                                                data: false
                                            });
                                        }
                                        break;
                                    case "delete":
                                        let req10 = await this.cmc.callAPI(resolverID, "delete_data", {
                                            databaseID: message.databaseID,
                                            table: message.a1,
                                            key: message.a2
                                        });
                                        if (req10.exist) {
                                            send?.({
                                                op: "cb",
                                                nonce: message.nonce,
                                                data: true
                                            });
                                        } else {
                                            send?.({
                                                op: "cb",
                                                nonce: message.nonce,
                                                data: false
                                            });
                                        }
                                        break;
                                    case "deleteTable":
                                        let req11 = await this.cmc.callAPI(resolverID, "delete_table", {
                                            databaseID: message.databaseID,
                                            table: message.a1
                                        });
                                        if (req11.exist) {
                                            send?.({
                                                op: "cb",
                                                nonce: message.nonce,
                                                data: true
                                            });
                                        } else {
                                            send?.({
                                                op: "cb",
                                                nonce: message.nonce,
                                                data: false
                                            });
                                        }
                                        break;
                                }
                            } else {
                                send?.({
                                    op: "cb",
                                    nonce: message.nonce,
                                    error: req7.error
                                });
                            }
                        } else {
                            send?.({
                                op: "cb",
                                nonce: message.nonce,
                                error: "Incompatible core/kernel (???)"
                            });
                        }
                }
            };
            this.child.on("message", m => {
                if (!this.ipcSend && this.child) {
                    this.ipcSend = this.child.send.bind(this.child);
                }
                handleMessage(m, this.ipcSend);
            });

            // Data transmission through STDERR from the child process, used when IPC is not available
            // Format of data is: PHANDLERA_TRANSMISSION<length><v8 serialized data>
            // PHANDLERA_TRANSMISSION is the magic header
            // Length is the length of the msgpack data, in 4 bytes unsigned big-endian integer
            //
            // Data could be fragmented (including header), so we need to store the data in a buffer
            let dataBuffer: number[] = [];
            let magicHeaderCorrect = 0;
            let magicHeader = "PHANDLERA_TRANSMISSION".split("").map((c) => c.charCodeAt(0));
            let lastMessageLength = -1;

            let isReading = false;
            this.child.stdio[2]?.on("data", (dataUnk) => {
                if (this.child?.killed) return;

                let data = Buffer.from(dataUnk);
                // Iterate through the data and check for magic header

                for (let i = 0; i < data.length; i++) {
                    if (isReading) {
                        // Dump data into buffer
                        dataBuffer.push(data[i]);

                        // Check if we have length bytes
                        if (dataBuffer.length >= magicHeader.length + 4) {
                            // Read length, but only once
                            if (lastMessageLength === -1) {
                                lastMessageLength = Buffer.from(
                                    dataBuffer.slice(magicHeader.length, magicHeader.length + 4)
                                ).readUint32BE(0);
                            }

                            // Check if we have enough data
                            if (dataBuffer.length >= magicHeader.length + 4 + lastMessageLength) {
                                // We have enough data, decode it
                                let msgpackData = Buffer.from(
                                    dataBuffer.slice(magicHeader.length + 4, magicHeader.length + 4 + lastMessageLength)
                                );
                                let decoded = deserialize(msgpackData);
                                if (!this.ipcSend) {
                                    this.ipcSend = (msg: any) => {
                                        let encoded = serialize(msg);
    
                                        let lengthBuffer = Buffer.alloc(4);
                                        lengthBuffer.writeUInt32BE(encoded.length, 0);
                                        let lengthBytes = Array.from(lengthBuffer);
                                        
                                        this.child?.stdin?.write(
                                            Buffer.from([...magicHeader, ...lengthBytes, ...encoded, 0x00])
                                        );
                                    };
                                }
                                handleMessage(decoded, this.ipcSend);

                                // Reset buffer
                                dataBuffer = [];
                                lastMessageLength = -1;
                                isReading = false;
                            }
                        }
                    }

                    if (data[i] === magicHeader[magicHeaderCorrect]) {
                        magicHeaderCorrect++;

                        if (magicHeaderCorrect === magicHeader.length) {
                            // Add header to data buffer
                            dataBuffer.push(...magicHeader);

                            isReading = true;
                        }
                    } else if (!isReading) {
                        magicHeaderCorrect = 0;
                    }
                }
            });

            await promise;
            this.started = true;
        }
    }
}