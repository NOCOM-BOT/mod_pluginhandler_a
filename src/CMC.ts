import { EventEmitter } from 'node:events';

export default class CMComm extends EventEmitter {
    apiCallbackTable: {
        [nonce: string]: (data: any) => void
    } = {};

    constructor() {
        super();

        // Handle handshake
        process.once("message", (msg: {
            type: "handshake",
            id: string,
            protocol_version: "1",
            config: any
        }) => {
            if (msg.protocol_version === "1") {
                process.send?.({
                    type: "handshake_success",
                    module: "pl_handler",
                    module_displayname: "A-Type Plugin Handler",
                    module_namespace: "pluginhandler_a"
                });

                this._handleEvents();
            } else {
                process.send?.({
                    type: "handshake_fail",
                    error: "Invalid protocol version"
                });
                process.exit();
            }
        });
    }

    callAPI(moduleID: string, cmd: string, data: any) {
        let nonce = moduleID + "A" + Math.random().toString(10).substring(2);
        let resolve = (value: ({
            exist: true,
            data: any,
            error: any
        } | { exist: false })) => { }, promise = new Promise<({
            exist: true,
            data: any,
            error: any
        } | { exist: false })>(r => resolve = r);
        this.apiCallbackTable[nonce] = resolve;

        process.send?.({
            type: "api_send",
            call_to: moduleID,
            call_cmd: cmd,
            data,
            nonce
        });

        return promise;
    }

    _handleEvents() {
        process.on("message", (msg: {
            type: string   
        } & (
            {
                type: "api_call",
                call_from: string,
                call_cmd: string,
                data: any,
                nonce: string
            } | 
            {
                type: "api_response",
                response_from: string,
                nonce: string
            } & (
                {
                    exist: true,
                    data: any,
                    error: any
                } | { exist: false }
            )
        )) => {
            switch (msg.type) {
                case "api_call":
                    let transmitted = this.emit(`api:${msg.call_cmd}`, msg.call_from, msg.data, (error: any, data: any) => {
                        process.send?.({
                            type: "api_sendresponse",
                            response_to: msg.call_from,
                            exist: true,
                            error,
                            data,
                            nonce: msg.nonce
                        })
                    });
                    
                    if (!transmitted) {
                        process.send?.({
                            type: "api_sendresponse",
                            response_to: msg.call_from,
                            exist: false,
                            nonce: msg.nonce
                        });
                    }
                    break;

                case "api_response":
                    if (this.apiCallbackTable[msg.nonce]) {
                        this.apiCallbackTable[msg.nonce]({
                            exist: msg.exist,
                            ...(msg.exist ? { data: msg.data, error: msg.error } : {})
                        });
                        delete this.apiCallbackTable[msg.response_from + msg.nonce];
                    }
            }
        });
    }
}
