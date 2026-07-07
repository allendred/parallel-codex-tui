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
