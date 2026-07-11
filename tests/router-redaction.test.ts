import { describe, expect, it } from "vitest";
import { sanitizeRouterText } from "../src/core/router-redaction.js";

describe("sanitizeRouterText", () => {
  it("keeps ordinary Router diagnostics unchanged", () => {
    expect(sanitizeRouterText("Codex Router timed out after 30000ms via proxy.test:8443"))
      .toBe("Codex Router timed out after 30000ms via proxy.test:8443");
  });

  it("keeps only safe URL endpoint context", () => {
    expect(sanitizeRouterText(
      "failed at https://user:secret@proxy.test:8443/private/path?token=hidden#trace, retry"
    )).toBe("failed at https://***@proxy.test:8443, retry");
    expect(sanitizeRouterText("proxy socks5h://127.0.0.1:1080/internal."))
      .toBe("proxy socks5h://127.0.0.1:1080.");
  });

  it("redacts authorization headers, secret assignments, and common raw tokens", () => {
    const sanitized = sanitizeRouterText(
      "Authorization: Bearer bearer-secret OPENAI_API_KEY=sk-proj-routersecret "
      + "CLIENT_SECRET='client-secret' npm_abcdefghijklmnopqrstuvwxyz "
      + "ghp_abcdefghijklmnopqrstuvwxyz123456"
    );

    expect(sanitized).toContain("Authorization: Bearer ***");
    expect(sanitized).toContain("OPENAI_API_KEY=***");
    expect(sanitized).toContain("CLIENT_SECRET=***");
    expect(sanitized).not.toMatch(/bearer-secret|routersecret|client-secret|npm_|ghp_/);
  });
});
