const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface EncryptedCredential {
  keyVersion: number;
  iv: string;
  encryptedPayload: string;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importKey(masterKey: string): Promise<CryptoKey> {
  const raw = bytes(masterKey);
  if (![16, 24, 32].includes(raw.byteLength)) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be base64 encoded AES key material");
  }
  return crypto.subtle.importKey("raw", raw as unknown as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptCredential(
  payload: Record<string, unknown>,
  masterKey: string,
  keyVersion = 1,
): Promise<EncryptedCredential> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(masterKey);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    encoder.encode(JSON.stringify(payload)) as unknown as BufferSource,
  );
  return { keyVersion, iv: base64(iv), encryptedPayload: base64(new Uint8Array(encrypted)) };
}

export async function decryptCredential(
  credential: EncryptedCredential,
  masterKey: string,
): Promise<Record<string, unknown>> {
  const key = await importKey(masterKey);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(credential.iv) as unknown as BufferSource },
    key,
    bytes(credential.encryptedPayload) as unknown as BufferSource,
  );
  const payload: unknown = JSON.parse(decoder.decode(decrypted));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Credential payload is invalid");
  }
  return payload as Record<string, unknown>;
}
