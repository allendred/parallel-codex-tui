declare module "@iarna/toml" {
  export function parse(source: string): unknown;
  export function stringify(value: unknown): string;
}
