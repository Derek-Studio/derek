/**
 * Shared factory function for creating log methods with specific levels
 * Used across different logger implementations to reduce code duplication
 */

// Type guard to check if a logger has a specific level method
// biome-ignore lint/suspicious/noExplicitAny: Generic logger type
function hasLevelMethod(logger: any, level: string): boolean {
	return logger && typeof logger[level] === 'function';
}

/**
 * Factory function to create log method with specific level
 * Returns overloaded function matching Logger interface
 *
 * @param logger - The underlying logger instance (Pino, console, etc.)
 * @param level - The log level ('info', 'error', 'warn', etc.)
 * @param options - Optional configuration for the log method
 * @returns An overloaded log method that accepts both string-first and object-first signatures
 */
// biome-ignore lint/suspicious/noExplicitAny: Generic logger type parameter
export function createLogMethod<T = any>(
	logger: T,
	level: string,
	options?: {
		contextPrefix?: string;
		consolePrefix?: string;
		consoleMethod?: keyof Console;
		transformArgs?: (args: unknown[], msg?: string) => unknown[];
		// biome-ignore lint/suspicious/noExplicitAny: Generic result type
		transformResult?: (result: any) => void;
	},
) {
	const {
		contextPrefix,
		consolePrefix,
		consoleMethod,
		transformArgs,
		transformResult,
	} = options || {};

	// Create overloaded function
	const logMethod = (msgOrObj: string | object, ...args: unknown[]) => {
		try {
			// Handle console prefix fallback case
			if (consolePrefix && consoleMethod && logger === console) {
				// This is for fallback logger with console prefixes
				if (typeof msgOrObj === 'object' && msgOrObj !== null) {
					// Object first: (obj: object, msg?: string) => void
					const obj = msgOrObj;
					const msg = args[0] as string | undefined;
					// biome-ignore lint/suspicious/noExplicitAny: Dynamic console method access
					(console as any)[consoleMethod](`[${consolePrefix}]`, msg || '', obj);
				} else {
					// String first: (msg: string, ...args: unknown[]) => void
					const msg = msgOrObj;
					const restArgs = args.slice(1);
					// biome-ignore lint/suspicious/noExplicitAny: Dynamic console method access
					(console as any)[consoleMethod](
						`[${consolePrefix}]`,
						msg,
						...restArgs,
					);
				}
				return;
			}

			// Transform arguments if needed
			const transformedArgs = transformArgs
				? transformArgs(
						args,
						typeof msgOrObj === 'string' ? msgOrObj : undefined,
					)
				: args;

			if (typeof msgOrObj === 'object' && msgOrObj !== null) {
				// Object first: (obj: object, msg?: string) => void
				const obj = msgOrObj as Record<string, unknown>;
				const msg = transformedArgs[0] as string | undefined;

				// Call the logger with object and optional message
				if (hasLevelMethod(logger, level)) {
					// biome-ignore lint/suspicious/noExplicitAny: Dynamic logger method access
					const result = (logger as any)[level](msg || '', obj);
					if (transformResult) {
						transformResult(result);
					}
				}
			} else {
				// String first: (msg: string, ...args: unknown[]) => void
				const msg = msgOrObj;

				// Add context prefix if specified
				const finalMsg = contextPrefix ? `[${contextPrefix}] ${msg}` : msg;

				// Call the logger with message and additional args
				if (hasLevelMethod(logger, level)) {
					// biome-ignore lint/suspicious/noExplicitAny: Dynamic logger method access
					const result = (logger as any)[level](finalMsg, ...transformedArgs);
					if (transformResult) {
						transformResult(result);
					}
				}
			}
		} catch (error) {
			// Fallback to console if logger method fails
			const fallbackLevel = level === 'trace' ? 'log' : level;
			const consoleMethod = console[fallbackLevel as keyof Console] as (
				// biome-ignore lint/suspicious/noExplicitAny: Variadic fallback console arguments
				...args: any[]
			) => void;
			if (typeof consoleMethod === 'function') {
				consoleMethod('Logger method failed:', {
					level,
					error: error instanceof Error ? error.message : String(error),
					message: msgOrObj,
					args,
				});
			}
		}
	};

	// Return the method with both overloads
	return logMethod as ((msg: string, ...args: unknown[]) => void) &
		((obj: object, msg?: string) => void);
}

/**
 * Create a set of log methods for all standard levels
 *
 * @param logger - The underlying logger instance
 * @param options - Optional configuration for all log methods
 * @returns An object containing log methods for all standard levels
 */
// biome-ignore lint/suspicious/noExplicitAny: Generic logger type parameter
export function createLogMethods<T = any>(
	logger: T,
	options?: {
		contextPrefix?: string;
		transformArgs?: (
			args: unknown[],
			level?: string,
			msg?: string,
		) => unknown[];
		// biome-ignore lint/suspicious/noExplicitAny: Generic result type
		transformResult?: (result: any, level?: string) => void;
		consolePrefix?: string;
		consoleMethod?: keyof Console;
	},
) {
	const {
		contextPrefix,
		transformArgs,
		transformResult,
		consolePrefix,
		consoleMethod,
	} = options || {};

	// Level-specific argument transformers if needed
	const createTransformer = (level: string) => {
		return (args: unknown[], msg?: string) => {
			if (transformArgs) {
				return transformArgs(args, level, msg);
			}
			return args;
		};
	};

	const createResultTransformer = (level: string) => {
		// biome-ignore lint/suspicious/noExplicitAny: Generic result type
		return (result: any) => {
			if (transformResult) {
				transformResult(result, level);
			}
		};
	};

	return {
		fatal: createLogMethod(logger, 'fatal', {
			contextPrefix: contextPrefix ? 'FATAL' : undefined,
			consolePrefix,
			consoleMethod,
			transformArgs: createTransformer('fatal'),
			transformResult: createResultTransformer('fatal'),
		}),
		error: createLogMethod(logger, 'error', {
			contextPrefix: contextPrefix ? 'ERROR' : undefined,
			consolePrefix,
			consoleMethod,
			transformArgs: createTransformer('error'),
			transformResult: createResultTransformer('error'),
		}),
		warn: createLogMethod(logger, 'warn', {
			contextPrefix: contextPrefix ? 'WARN' : undefined,
			consolePrefix,
			consoleMethod,
			transformArgs: createTransformer('warn'),
			transformResult: createResultTransformer('warn'),
		}),
		info: createLogMethod(logger, 'info', {
			contextPrefix: contextPrefix ? 'INFO' : undefined,
			consolePrefix,
			consoleMethod,
			transformArgs: createTransformer('info'),
			transformResult: createResultTransformer('info'),
		}),
		http: createLogMethod(logger, 'http', {
			contextPrefix: contextPrefix ? 'HTTP' : undefined,
			consolePrefix,
			consoleMethod,
			transformArgs: createTransformer('http'),
			transformResult: createResultTransformer('http'),
		}),
		debug: createLogMethod(logger, 'debug', {
			contextPrefix: contextPrefix ? 'DEBUG' : undefined,
			consolePrefix,
			consoleMethod,
			transformArgs: createTransformer('debug'),
			transformResult: createResultTransformer('debug'),
		}),
		trace: createLogMethod(logger, 'trace', {
			contextPrefix: contextPrefix ? 'TRACE' : undefined,
			consolePrefix,
			consoleMethod,
			transformArgs: createTransformer('trace'),
			transformResult: createResultTransformer('trace'),
		}),
	};
}
