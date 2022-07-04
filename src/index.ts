import CMComm from "./CMC";
import Logger from "./Logger";

import AdmZip from "adm-zip";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

let cmc = new CMComm();

let tempDirResp = await cmc.callAPI("core", "get_temp_folder", null);
if (!tempDirResp.exist)
    throw new Error("Unsupported kernel version");

let tempDir = tempDirResp.data;

let logger = new Logger(cmc);

async function compliantTest(data: (
    { filename: string, pathname: undefined } |
    { pathname: string, filename: undefined }
), callback: (error: string | null, data?: any) => void) {
    if (data.filename) {
        try {
            let zip = new AdmZip(data.filename);
            let zipEntries = zip.getEntries();
            if (zipEntries.length < 2) {
                callback("Invalid content (missing files)", {
                    compliant: false
                });
                return;
            }
            let zipEntry = zipEntries.find(x => x.entryName === "plugin.json");
            if (!zipEntry) {
                callback("plugin.json not found", {
                    compliant: false
                });
                return;
            }

            try {
                let pJSON = JSON.parse(zipEntry.getData().toString());
                try {
                    compliantTest_pJSON(pJSON);
                } catch (e) {
                    callback(String(e), {
                        compliant: false
                    });
                }

                callback(null, pJSON);
            } catch {
                callback("Invalid plugin.json", {
                    compliant: false
                });
            }
        } catch {
            callback("Invalid ZIP file", {
                compliant: false
            });
        }
    } else if (data.pathname) {
        // Test if plugin is spec-compliant
        try {
            let pJSON = JSON.parse(await fs.readFile(path.join(data.pathname, "plugin.json"), { encoding: "utf8" }));

            try {
                compliantTest_pJSON(pJSON);
            } catch (e) {
                callback(String(e), {
                    compliant: false
                });
                return;
            }

            callback(null, {
                compliant: true,
                pluginName: pJSON.pluginName,
                namespace: pJSON.pluginNamespace,
                version: pJSON.pluginVersion,
                author: pJSON.author,
            });
            return;
        } catch {
            callback("Invalid plugin.json", {
                compatible: false
            });
        }
    } else {
        callback("No filename or pathname provided", null);
    }
}

cmc.on("api:check_plugin", (from: string, data: (
    { filename: string, pathname: undefined } |
    { pathname: string, filename: undefined }
), callback: (error: string | null, data?: any) => void) => compliantTest(data, callback));

cmc.on("api:load_plugin", async (from: string, data: (
    { filename: string, pathname: undefined } |
    { pathname: string, filename: undefined }
), callback: (error: string | null, data?: any) => void) => {
    interface LPData {
        compliant: boolean,
        error?: string,
        pluginName?: string,
        namespace?: string,
        version?: string,
        author?: string
    }
    let rpromise: (data: LPData) => void;
    let promise = new Promise<LPData>((resolve) => rpromise = resolve);

    compliantTest(data, (error, data) => {
        if (error) {
            rpromise({
                ...data,
                error
            });
        } else {
            rpromise(data);
        }
    });

    let ctData = await promise;
    if (!ctData.compliant) {
        callback(null, {
            loaded: false,
            error: ctData.error ?? null
        });
        return;
    } else {
        try {
            logger.info("phandler_A", "Loading plugin", ctData.pluginName, "v" + ctData.version, "by", ctData.author, "(namespace " + ctData.namespace + ")");

            let moduleTempPath = path.join(tempDir, ctData.namespace + "-" + randomBytes(24).toString("hex"));
            if (data.filename) {
                let zip = new AdmZip(data.filename);
                // Extract ZIP to a temporary directory.
                await promisify(zip.extractAllToAsync)(moduleTempPath, true, false);
            } else if (data.pathname) {
                await fs.cp(data.pathname, moduleTempPath, {
                    recursive: true
                });
            }

            
        } catch (e) {
            callback(null, {
                loaded: false,
                error: String(e)
            });
            return;
        }
    }
});

function compliantTest_pJSON(pJSON: any) {
    if (pJSON.formatVersion !== 0) throw new Error("Invalid format version");
    if (typeof pJSON.author !== "string") throw new Error("Plugin must have author");
    if (typeof pJSON.pluginVersion !== "string") throw new Error("Plugin must have version");
    if (typeof pJSON.pluginName !== "string") throw new Error("Plugin must have name");
    if (typeof pJSON.pluginNamespace !== "string") throw new Error("Plugin must have namespace");
    if (typeof pJSON.entryPoint !== "string") throw new Error("Plugin must have entry point");
    if (pJSON.subclass === 0) {
        if (pJSON.entrypoint.endsWith(".cjs")) {
            throw new Error("CommonJS is not supported. If you want to use CommonJS, you must have ESM module as entry point then bootstrap to CJS.");
        }
        if (!pJSON.entrypoint.endsWith(".js") && !pJSON.entrypoint.endsWith(".mjs")) {
            throw new Error("Entry point must be an (ESM module) JavaScript file");
        }
    }
    if (pJSON.subclass === 1) {
        if (!pJSON.entryPoint.endsWith(".ts")) {
            throw new Error("Entry point must be a TypeScript file");
        }
    }
}
