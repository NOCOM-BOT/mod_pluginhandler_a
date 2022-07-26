import CMComm from "./CMC.js";
import Logger from "./Logger.js";
import Plugin from "./Plugin.js";

import AdmZip from "adm-zip";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

let pList: { [namespace: string]: Plugin } = {};
let cmc = new CMComm();

let tempDirResp = await cmc.callAPI("core", "get_temp_folder", null);
if (!tempDirResp.exist)
    throw new Error("Unsupported kernel version");

let tempDir = tempDirResp.data;

let logger = new Logger(cmc);

async function compliantTest(data: (
    { filename: string, pathname?: null } |
    { pathname: string, filename?: null }
), cb?: (error: string | null, data?: any) => void) {
    let callback: (error: string | null, data?: any) => void = (error: string | null, data?: any) => {};
    let promise = new Promise<any>((resolve, reject) => {
        callback = (error: string | null, data?: any) => {
            if (error)
                reject(error);
            else
                resolve(data);

            cb?.(error, data);
        }
    });

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
            let zipEntry = zipEntries.find(x => x.entryName === "package.json");
            if (!zipEntry) {
                callback("package.json not found", {
                    compliant: false
                });
                return;
            }

            try {
                let pJSONBase = JSON.parse(zipEntry.getData().toString());
                if (pJSONBase.NOCOM_AType_Metadata) {
                    let pJSON = pJSONBase.NOCOM_AType_Metadata;
                    try {
                        compliantTest_pJSON(pJSON);
                    } catch (e) {
                        callback(String(e), {
                            compliant: false
                        });
                    }

                    callback(null, {
                        compliant: true,
                        pluginName: pJSON.pluginName,
                        namespace: pJSON.pluginNamespace,
                        version: pJSON.pluginVersion,
                        author: pJSON.author,
                    });
                } else {
                    callback("Invalid content (missing metadata)", {
                        compliant: false
                    });
                }
            } catch {
                callback("Invalid package.json", {
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
            let pJSONBase = JSON.parse(await fs.readFile(path.join(data.pathname, "package.json"), { encoding: "utf8" }));
            let pJSON = pJSONBase.NOCOM_AType_Metadata;

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
            callback("Invalid package.json", {
                compatible: false
            });
        }
    } else {
        callback("No filename or pathname provided", null);
    }

    return promise;
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

            let plugin = new Plugin(moduleTempPath, cmc, logger);
            await plugin.start();

            pList[ctData.namespace ?? "???"] = plugin;

            callback(null, {
                loaded: true,
                pluginName: ctData.pluginName,
                namespace: ctData.namespace,
                version: ctData.version,
                author: ctData.author
            });
        } catch (e) {
            logger.error("phandler_A", "Error while starting plugin", ctData.pluginName, "v" + ctData.version, "by", ctData.author, "(namespace " + ctData.namespace + "):", String(e));
            callback(null, {
                loaded: false,
                error: String(e)
            });
            return;
        }
    }
});

cmc.on("api:unload_plugin", async (from: string, data: {
    namespace: string
}, callback: (error: string | null, data?: any) => void) => {
    if (!pList[data.namespace]) {
        callback("Plugin not loaded", {
            error: "Plugin not loaded"
        });
        return;
    }

    try {
        logger.info("phandler_A", "Unloading plugin", data.namespace);
        await pList[data.namespace].stop();
    } catch (e) {
        pList[data.namespace].forceStop();
    }

    delete pList[data.namespace];

    callback(null, {});
});

cmc.on("api:plugin_call", async (from: string, data: {
    namespace: string,
    funcName: string,
    args: any[]
}, callback: (error: string | null, data?: any) => void) => {
    if (!pList[data.namespace]) {
        callback("Plugin not loaded", {
            error: "Plugin not loaded"
        });
        return;
    }

    try {
        let res = await pList[data.namespace].call(data.funcName, data.args);
        callback(null, {
            returnData: res
        });
    } catch (e) {
        callback(String(e), {
            error: String(e),
            returnData: null
        });
    }
});

cmc.on("api:plugin_search", async (from: string, data: {
    pathname: string
}, callback: (error: string | null, data?: any) => void) => {
    // Search for .zip files and subdirectory in the given path
    let files = await fs.readdir(data.pathname, {
        withFileTypes: true,
        encoding: "utf8"
    });
    let zipFiles: string[] = [];
    let subdirectories: string[] = [];
    for (let file of files) {
        if (file.name.endsWith(".zip") && file.isFile()) {
            zipFiles.push(path.join(data.pathname, file.name));
        } else if (file.isDirectory()) {
            subdirectories.push(path.join(data.pathname, file.name));
        }
    }

    // Do a compliance test on each ZIP file and each subdirectory
    let compliant: string[] = [];
    // Test for ZIP files first
    for (let zipFile of zipFiles) {
        try {
            await compliantTest({
                filename: zipFile
            });
            
            compliant.push(zipFile);
        } catch {}
    }

    // Test for subdirectories
    for (let subdirectory of subdirectories) {
        try {
            await compliantTest({
                pathname: subdirectory
            });
            
            compliant.push(subdirectory);
        } catch {}
    }

    callback(null, {
        valid: compliant
    });
});

function compliantTest_pJSON(pJSON: any) {
    if (pJSON.formatVersion !== 0) throw new Error("Invalid format version");
    if (typeof pJSON.author !== "string") throw new Error("Plugin must have author");
    if (typeof pJSON.pluginVersion !== "string") throw new Error("Plugin must have version");
    if (typeof pJSON.pluginName !== "string") throw new Error("Plugin must have name");
    if (typeof pJSON.pluginNamespace !== "string") throw new Error("Plugin must have namespace");
    if (typeof pJSON.entryPoint !== "string") throw new Error("Plugin must have entry point");
    if (pJSON.subclass === 0) {
        if (pJSON.entryPoint.endsWith(".cjs")) {
            throw new Error("CommonJS is not supported. If you want to use CommonJS, you must have ESM module as entry point then bootstrap to CJS.");
        }
        if (!pJSON.entryPoint.endsWith(".js") && !pJSON.entrypoint.endsWith(".mjs")) {
            throw new Error("Entry point must be an (ESM module) JavaScript file");
        }
    }
    if (pJSON.subclass === 1) {
        if (!pJSON.entryPoint.endsWith(".ts")) {
            throw new Error("Entry point must be a TypeScript file");
        }
    }
}
