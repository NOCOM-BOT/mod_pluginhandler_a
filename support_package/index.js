export function verifyPlugin(allow) {
    process.send({
        op: "verifyPlugin",
        allow: allow
    });
}
