declare module "@wgtechlabs/secrets-engine" {
  interface OpenOptions {
    path?: string;
    location?: "xdg";
  }

  interface ResetOptions extends OpenOptions {
    preserveDirectory?: boolean;
  }

  class SecretsEngine {
    static open(options?: OpenOptions): Promise<SecretsEngine>;
    static destroyAtPath(options?: OpenOptions): Promise<void>;
    static resetAtPath(options?: ResetOptions): Promise<SecretsEngine>;

    get(key: string): Promise<string | null>;
    getOrThrow(key: string): Promise<string>;
    set(key: string, value: string): Promise<void>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    keys(pattern?: string): Promise<string[]>;
    destroy(): Promise<void>;
    close(): Promise<void>;
    readonly size: number;
    readonly storagePath: string;
  }

  class SecretsEngineError extends Error {
    code: string;
  }
  class SecurityError extends SecretsEngineError {}
  class IntegrityError extends SecretsEngineError {
    subcode: string;
  }
  class KeyNotFoundError extends SecretsEngineError {}
  class DecryptionError extends SecretsEngineError {}
  class InitializationError extends SecretsEngineError {}
}
