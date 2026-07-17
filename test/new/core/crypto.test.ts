import { expect, test } from "bun:test";
import {
  decrypt,
  encrypt,
  hashPassword,
  requireKey,
  verifyPassword,
} from "../../../packages/core/src/crypto.ts";
import { policyForPermission } from "../../../packages/core/src/policy.ts";

const key = requireKey(Buffer.alloc(32, 7).toString("base64"), "TEST_KEY");

test("encrypts secrets and verifies scrypt passwords", async () => {
  const password = await hashPassword("a secure password");
  expect(await verifyPassword("a secure password", password)).toBe(true);
  expect(await verifyPassword("wrong password", password)).toBe(false);
  expect(decrypt(encrypt("discord-token", key), key)).toBe("discord-token");
});

test("asks before side effects and permits sandbox-local work", () => {
  expect(policyForPermission({ kind: "write" })).toBe("allow");
  expect(
    policyForPermission({ kind: "shell", fullCommandText: "bun test" }),
  ).toBe("allow");
  expect(
    policyForPermission({
      kind: "shell",
      fullCommandText: "git push origin main",
    }),
  ).toBe("ask");
  expect(policyForPermission({ kind: "url", url: "https://example.com" })).toBe(
    "ask",
  );
});
