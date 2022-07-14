import { fork } from 'node:child_process';
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type CMComm from "./CMC";
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default class Plugin {
    started: boolean = false;
    path: string;
    child?: ChildProcess;
    cmc: CMComm;

    constructor(path: string, cmc: CMComm) {
        this.path = path;
        this.cmc = cmc;
    }

    async start() {
        if (this.started) {
            return;
        }

        // Read plugin.json
        let pJSON: {
            formatVersion: number,
            pluginName: string,
            pluginNamespace: string,
            pluginVersion: string,
            entryPoint: string,
            author: string,
            subclass: number
            [x: string]: any
        };
        try {
            pJSON = JSON.parse(await fs.readFile(path.join(this.path, "plugin.json"), { encoding: "utf8" }));
        } catch (e) {
            throw new Error("Invalid plugin.json");
        }

        if (pJSON.formatVersion !== 0) {
            throw new Error("Invalid plugin.json");
        }

        if (!pJSON.entryPoint) {
            throw new Error("Invalid plugin.json");
        }

        // Package download
        await this.cmc.callAPI("core", "pnpm_install", {
            path: this.path
        });

        // Add support package
        await this.cmc.callAPI("core", "pnpm_install_specific", {
            path: this.path,
            dep: path.join(__dirname, "..", "support_package")
        });

        if (pJSON.subclass === 0) {
            this.child = fork(path.join(this.path, pJSON.entryPoint), {
                cwd: this.path,
                stdio: ["ignore", "ignore", "ignore", 'ipc']
            });

            try {
                await this.handleChild();
            } catch (e) {

            }
        } else if (pJSON.subclass === 1) {
            throw new Error("Subclass 1 is not supported yet.");
        } else {
            throw new Error("Invalid plugin.json");
        }
    }

    async handleChild() {
        if (this.child) {
            let res: () => void, rej: (e: any) => void, promise = new Promise<void>((resolve, reject) => {
                res = resolve; rej = reject;
                setTimeout(() => reject(new Error("Timeout")), 30000);
            });

            this.child.on("message", (message: any) => {
                switch (message.op) {
                    case "verifyPlugin":
                        if (!message.allow) {
                            this.child?.kill();
                            this.child = undefined;
                            rej(new Error("Plugin is not allowed to run."));
                        }
                        res();
                        break;
                }
            });
        }
    }
}