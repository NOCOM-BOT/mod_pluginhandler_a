import { EventEmitter } from 'node:events';

export default class CMComm extends EventEmitter {
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
            }
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
            }
        });
    }
}
