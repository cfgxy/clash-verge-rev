export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `digest` refuses a view onto a SharedArrayBuffer, which the plain
  // `Uint8Array` type still allows; the copy narrows it to a private buffer.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
