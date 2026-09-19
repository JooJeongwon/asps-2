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
