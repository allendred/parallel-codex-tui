import { StringDecoder } from "node:string_decoder";

export interface RawInputDecoder {
  write(chunk: Buffer | string | null | undefined): string;
  end(): string;
}

export function createRawInputDecoder(): RawInputDecoder {
  const decoder = new StringDecoder("utf8");

  return {
    write(chunk) {
      if (chunk == null) {
        return "";
      }
      if (Buffer.isBuffer(chunk)) {
        return decoder.write(chunk);
      }
      return chunk;
    },
    end() {
      return decoder.end();
    }
  };
}

export function tokenizeRawInput(input: string): string[] {
  return Array.from(
    input.matchAll(/\x1b\[M[\s\S]{3}|\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[\s\S]|\x1b[^\x00-\x1f\x7f]|[\s\S]/gu),
    (match) => match[0]
  );
}
