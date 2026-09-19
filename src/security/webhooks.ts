const encoder = new TextEncoder();

export async function verifyWebhookSecret(expected: string, provided: string | null): Promise<boolean> {
  if (!expected || !provided) return false;
  const [expectedHash, providedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  const expectedBytes = new Uint8Array(expectedHash);
  const providedBytes = new Uint8Array(providedHash);
  let difference = expectedBytes.length ^ providedBytes.length;
  for (let index = 0; index < expectedBytes.length; index += 1) difference |= expectedBytes[index] ^ (providedBytes[index] ?? 0);
  return difference === 0;
}

export async function verifyNotionWebhookSignature(body: string, signature: string | null, verificationToken: string): Promise<boolean> {
  if (!signature || !verificationToken || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(verificationToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  const actual = signature.slice(7).toLowerCase();
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ (actual.charCodeAt(index) || 0);
  return difference === 0;
}
