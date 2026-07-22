const DEFAULT_MAX_SUBMIT_BYTES = 1024 * 1024;

export interface SubmitInputStream extends AsyncIterable<unknown> {
  isTTY?: boolean;
}

export async function resolveSubmitRequest(
  source: string | null,
  input: SubmitInputStream = process.stdin,
  maxBytes = DEFAULT_MAX_SUBMIT_BYTES
): Promise<string> {
  if (!source) {
    throw new Error("--submit requires request text or - for piped stdin");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Submit input limit must be a positive integer");
  }

  if (source !== "-") {
    return validateSubmitRequest(source, maxBytes);
  }
  if (input.isTTY) {
    throw new Error("--submit - requires piped stdin");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk instanceof Uint8Array ? chunk : String(chunk));
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Submit request exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return validateSubmitRequest(Buffer.concat(chunks, totalBytes).toString("utf8"), maxBytes);
}

function validateSubmitRequest(request: string, maxBytes: number): string {
  const normalized = request.trim();
  if (!normalized) {
    throw new Error("Submit request cannot be empty");
  }
  if (Buffer.byteLength(normalized) > maxBytes) {
    throw new Error(`Submit request exceeds ${maxBytes} bytes`);
  }
  return normalized;
}
