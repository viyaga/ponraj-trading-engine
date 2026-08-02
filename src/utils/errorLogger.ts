import util from "util";

const errorLogger = {
    error: (message: string, meta?: any) => {
        const timestamp = new Date().toISOString();
        let msg = `${timestamp} [ERROR] [error-logger]: ${message}`;
        if (meta) {
            if (meta instanceof Error) {
                msg += `\n${meta.stack || meta.message}`;
            } else {
                msg += ` ${util.inspect(meta, { depth: 4 })}`;
            }
        }
        console.error(msg);
    }
};

export default errorLogger;
