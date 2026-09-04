import util from "util";

const errorLogger = {
    error: (message: string, meta?: any) => {
        const timestamp = new Date().toISOString();
        let msg = `${timestamp} [ERROR] [error-logger]: ${message}`;
        if (meta !== undefined) {
            if (meta instanceof Error) {
                msg += `\n${meta.stack || meta.message}`;
            } else if (typeof meta === 'object' && meta !== null) {
                if (meta.error instanceof Error) {
                    const { error, ...rest } = meta;
                    msg += `\nError: ${error.stack || error.message}`;
                    if (Object.keys(rest).length > 0) {
                        msg += `\nDetails: ${util.inspect(rest, { depth: 6, colors: false })}`;
                    }
                } else {
                    msg += `\n${util.inspect(meta, { depth: 6, colors: false })}`;
                }
            } else {
                msg += ` ${meta}`;
            }
        }
        console.error(msg);
    }
};

export default errorLogger;
