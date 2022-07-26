import { fork } from 'node:child_process';
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type CMComm from "./CMC.js";
import type Logger from "./Logger.js";
import { fileURLToPath, pathToFileURL } from 'url';
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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

        if (pJSON.formatVersion !== 0) {
            throw new Error("Invalid metadata");
        }

        if (!pJSON.entryPoint) {
            throw new Error("Invalid metadata");
        }

        this.pJSON = pJSON;

        // Add support package
        await this.cmc.callAPI("core", "pnpm_install_specific", {
            path: this.path,
            dep: path.join(__dirname, "..", "support_package")
        });

        // Package download
        await this.cmc.callAPI("core", "pnpm_install", {
            path: this.path
        });

        if (pJSON.subclass === 0) {
            // PNPM handle things kinda slowly and weirdly, so we need to check if support package
            // is installed first
            // THIS THING TOOK ME 3 HOURS TO FIGURE OUT
            let supportPackagePath = path.join(this.path, "node_modules", "@nocom_bot", "nocom-atype-support");
            for (;;) {
                // Check for support package every 100ms
                await new Promise(resolve => setTimeout(resolve, 100));
                try {
                    // Test import index.js
                    await import(pathToFileURL(path.join(supportPackagePath, "index.js")).toString());
                    // Test package.json
                    JSON.parse(await fs.readFile(path.join(supportPackagePath, "package.json"), { encoding: "utf8" }));
                    break;
                } catch {}
            }

            this.child = fork(path.join(this.path, pJSON.entryPoint), [], {
                cwd: path.join(this.path),
                silent: false
                //stdio: ["ignore", "ignore", "ignore", 'ipc']
            });

            try {
                await this.handleChild();
            } catch (e) {
                this.child.kill();
                throw e;
            }
        } else if (pJSON.subclass === 1) {
            throw new Error("Subclass 1 is not supported yet.");
        } else {
            throw new Error("Invalid metadata");
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

        this.child.send({
            op: "api_call",
            func: funcName,
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

            this.child.on("message", async (message: any) => {
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
                                    this.child?.send({
                                        op: "cb",
                                        nonce: message.nonce,
                                        data: req2.data.returnData,
                                        error: req2.data.error
                                    });
                                } else {
                                    this.child?.send({
                                        op: "cb",
                                        nonce: message.nonce,
                                        error: "Module resolver failed"
                                    });
                                }
                            } else {
                                this.child?.send({
                                    op: "cb",
                                    nonce: message.nonce,
                                    error: "Namespace not found"
                                });
                            }
                        } else {
                            this.child?.send({
                                op: "cb",
                                nonce: message.nonce,
                                error: "Incompatible core/kernel (???)"
                            });
                        }
                        break;

                    case "callAPI":
                        let req3 = await this.cmc.callAPI(message.moduleID, message.cmd, message.value);
                        if (req3.exist) {
                            this.child?.send({
                                op: "cb",
                                nonce: message.nonce,
                                error: req3.error,
                                data: req3.data
                            });
                        } else {
                            this.child?.send({
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

                                        if (!reqTO) {
                                            continue;
                                        }
                                    }

                                    let req5 = await this.cmc.callAPI(typedModule.moduleID, "register_cmd", {
                                        namespace: this.pJSON?.pluginNamespace,
                                        command: message.commandName,
                                        funcName: message.funcName,
                                        funcDescAPI: message.funcDescAPI
                                    });

                                    if (req5.exist) {
                                        this.child?.send({
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

                            this.child?.send({
                                op: "cb",
                                nonce: message.nonce,
                                error: "Command handler is not installed"
                            });
                        } else {
                            this.child?.send({
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
                            this.child?.send({
                                op: "cb",
                                nonce: message.nonce,
                                error: req6.error,
                                data: {
                                    success: req6.data?.success ?? false
                                }
                            });
                        } else {
                            this.child?.send({
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
                }
            });

            await promise;
            this.started = true;
        }
    }
}