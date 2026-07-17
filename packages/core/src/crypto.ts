import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  scrypt as nodeScrypt,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const KEY_BYTES = 32;

function scrypt(
  password: string,
  salt: Buffer,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, length, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(Buffer.from(derivedKey));
    });
  });
}

export function requireKey(value: string | undefined, name: string): Buffer {
  if (!value) throw new Error(`${name} is required`);
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`${name} must be a base64-encoded 32-byte key`);
  }
  return key;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12)
    throw new Error("password must be at least 12 characters");
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString("base64url")}.${hash.toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [saltText, hashText] = encoded.split(".");
  if (!saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actual = await scrypt(
    password,
    Buffer.from(saltText, "base64url"),
    expected.length,
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string, key: Buffer): string {
  return createHmac("sha256", key).update(token).digest("hex");
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export function decrypt(ciphertext: string, key: Buffer): string {
  const [ivText, tagText, payloadText] = ciphertext.split(".");
  if (!ivText || !tagText || !payloadText)
    throw new Error("invalid encrypted value");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(payloadText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
