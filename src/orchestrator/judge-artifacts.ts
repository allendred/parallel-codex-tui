import { Lexer, type Token, type Tokens } from "marked";

export const JUDGE_REQUIRED_ARTIFACTS = [
  "requirements.md",
  "plan.md",
  "acceptance.md",
  "actor-brief.md",
  "critic-brief.md"
] as const;

export const JUDGE_VALIDATION_FILE = "judge-validation.json";

export type JudgeArtifactName = typeof JUDGE_REQUIRED_ARTIFACTS[number];

export interface JudgeContractItem {
  id: string;
  text: string;
  references: string[];
}

export interface JudgeArtifactIssue {
  file: JudgeArtifactName;
  code:
    | "missing"
    | "parse_error"
    | "missing_list_items"
    | "missing_content"
    | "placeholder_only"
    | "placeholder_items"
    | "duplicate_item_id"
    | "unknown_requirement_reference";
  message: string;
}

export interface JudgeArtifactValidation {
  state: "valid" | "invalid";
  item_count: number;
  content_count: number;
  issues: JudgeArtifactIssue[];
}

export interface JudgeValidationReport {
  version: 1;
  state: "valid" | "invalid";
  artifacts: Record<JudgeArtifactName, JudgeArtifactValidation>;
  contract: {
    requirements: JudgeContractItem[];
    plan: JudgeContractItem[];
    acceptance: JudgeContractItem[];
  };
  briefs: {
    actor: string[];
    critic: string[];
  };
  issues: JudgeArtifactIssue[];
}

interface ParsedMarkdown {
  listItems: string[];
  content: string[];
  parseError?: string;
}

interface ContractArtifactResult {
  validation: JudgeArtifactValidation;
  items: JudgeContractItem[];
}

interface BriefArtifactResult {
  validation: JudgeArtifactValidation;
  content: string[];
}

const CONTRACT_ARTIFACTS = {
  "requirements.md": { prefix: "R", label: "requirement" },
  "plan.md": { prefix: "P", label: "plan step" },
  "acceptance.md": { prefix: "A", label: "acceptance criterion" }
} as const;

const PLACEHOLDER_PATTERN = /^(?:todo|tbd|pending|placeholder|to be determined|coming soon|n\/?a|none|待定|稍后(?:补充|处理)?|后续(?:补充|再说)?|暂无|未定|占位(?:内容)?)(?:\s*[:：-].*)?$/iu;
const ARTIFACT_NAME_PATTERN = /^(?:requirements|plan|acceptance|actor-brief|critic-brief)\.md$/iu;

export function validateJudgeArtifacts(
  input: Partial<Record<JudgeArtifactName, string>>
): JudgeValidationReport {
  const requirements = validateContractArtifact("requirements.md", input["requirements.md"] ?? "");
  const plan = validateContractArtifact("plan.md", input["plan.md"] ?? "");
  const acceptance = validateContractArtifact("acceptance.md", input["acceptance.md"] ?? "");
  const actorBrief = validateBriefArtifact("actor-brief.md", input["actor-brief.md"] ?? "");
  const criticBrief = validateBriefArtifact("critic-brief.md", input["critic-brief.md"] ?? "");

  const requirementIds = new Set(requirements.items.map((item) => item.id));
  for (const item of acceptance.items) {
    const unknown = item.references.filter((reference) => !requirementIds.has(reference));
    if (unknown.length > 0) {
      acceptance.validation.issues.push(issue(
        "acceptance.md",
        "unknown_requirement_reference",
        `${item.id} references unknown requirement${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`
      ));
      acceptance.validation.state = "invalid";
    }
  }

  const artifacts: Record<JudgeArtifactName, JudgeArtifactValidation> = {
    "requirements.md": requirements.validation,
    "plan.md": plan.validation,
    "acceptance.md": acceptance.validation,
    "actor-brief.md": actorBrief.validation,
    "critic-brief.md": criticBrief.validation
  };
  const issues = JUDGE_REQUIRED_ARTIFACTS.flatMap((file) => artifacts[file].issues);

  return {
    version: 1,
    state: issues.length === 0 ? "valid" : "invalid",
    artifacts,
    contract: {
      requirements: requirements.items,
      plan: plan.items,
      acceptance: acceptance.items
    },
    briefs: {
      actor: actorBrief.content,
      critic: criticBrief.content
    },
    issues
  };
}

function validateContractArtifact(
  file: keyof typeof CONTRACT_ARTIFACTS,
  markdown: string
): ContractArtifactResult {
  const parsed = parseMarkdown(markdown);
  const issues: JudgeArtifactIssue[] = [];
  const spec = CONTRACT_ARTIFACTS[file];

  if (!markdown.trim()) {
    issues.push(issue(file, "missing", `${file} is missing or empty.`));
  } else if (parsed.parseError) {
    issues.push(issue(file, "parse_error", `${file} is not valid Markdown: ${parsed.parseError}`));
  }

  const normalized = parsed.listItems.map((text, index) => normalizeContractItem(text, spec.prefix, index));
  const meaningful = normalized.filter((item) => isMeaningful(item.text));
  const placeholders = normalized.filter((item) => !isMeaningful(item.text));

  if (markdown.trim() && !parsed.parseError && parsed.listItems.length === 0) {
    issues.push(issue(file, "missing_list_items", `${file} must contain at least one Markdown list ${spec.label}.`));
  } else if (parsed.listItems.length > 0 && meaningful.length === 0) {
    issues.push(issue(file, "placeholder_only", `${file} contains only placeholder ${spec.label}s.`));
  } else if (placeholders.length > 0) {
    issues.push(issue(file, "placeholder_items", `${file} still contains ${placeholders.length} placeholder ${spec.label}${placeholders.length === 1 ? "" : "s"}.`));
  }

  const duplicateIds = repeatedIds(meaningful);
  if (duplicateIds.length > 0) {
    issues.push(issue(file, "duplicate_item_id", `${file} repeats item id${duplicateIds.length === 1 ? "" : "s"}: ${duplicateIds.join(", ")}.`));
  }

  return {
    validation: {
      state: issues.length === 0 ? "valid" : "invalid",
      item_count: parsed.listItems.length,
      content_count: parsed.content.length,
      issues
    },
    items: meaningful
  };
}

function validateBriefArtifact(
  file: "actor-brief.md" | "critic-brief.md",
  markdown: string
): BriefArtifactResult {
  const parsed = parseMarkdown(markdown);
  const issues: JudgeArtifactIssue[] = [];
  const meaningful = parsed.content.filter(isMeaningful);
  const placeholders = parsed.content.filter((content) => !isMeaningful(content));

  if (!markdown.trim()) {
    issues.push(issue(file, "missing", `${file} is missing or empty.`));
  } else if (parsed.parseError) {
    issues.push(issue(file, "parse_error", `${file} is not valid Markdown: ${parsed.parseError}`));
  } else if (parsed.content.length === 0) {
    issues.push(issue(file, "missing_content", `${file} must contain implementation guidance below its heading.`));
  } else if (meaningful.length === 0) {
    issues.push(issue(file, "placeholder_only", `${file} contains only placeholder guidance.`));
  } else if (placeholders.length > 0) {
    issues.push(issue(file, "placeholder_items", `${file} still contains placeholder guidance.`));
  }

  return {
    validation: {
      state: issues.length === 0 ? "valid" : "invalid",
      item_count: parsed.listItems.length,
      content_count: parsed.content.length,
      issues
    },
    content: meaningful
  };
}

function parseMarkdown(markdown: string): ParsedMarkdown {
  if (!markdown.trim()) {
    return { listItems: [], content: [] };
  }

  try {
    const tokens = Lexer.lex(markdown);
    return {
      listItems: collectListItems(tokens),
      content: collectContent(tokens)
    };
  } catch (error) {
    return {
      listItems: [],
      content: [],
      parseError: error instanceof Error ? error.message : String(error)
    };
  }
}

function collectListItems(tokens: Token[]): string[] {
  const items: string[] = [];
  for (const token of tokens) {
    if (isListToken(token)) {
      for (const item of token.items) {
        const text = normalizeWhitespace(item.tokens
          .filter((itemToken) => itemToken.type !== "list")
          .map(tokenPlainText)
          .join(" "));
        items.push(text);
        items.push(...collectListItems(item.tokens.filter(isListToken)));
      }
      continue;
    }
    const nested = tokenTokens(token);
    if (nested.length > 0) {
      items.push(...collectListItems(nested));
    }
  }
  return items;
}

function collectContent(tokens: Token[]): string[] {
  const content: string[] = [];
  for (const token of tokens) {
    if (token.type === "heading" || token.type === "space" || token.type === "hr" || token.type === "def") {
      continue;
    }
    if (isListToken(token)) {
      content.push(...collectListItems([token]));
      continue;
    }
    if (token.type === "blockquote") {
      content.push(...collectContent(tokenTokens(token)));
      continue;
    }
    const text = normalizeWhitespace(tokenPlainText(token));
    if (text) {
      content.push(text);
    }
  }
  return content;
}

function normalizeContractItem(text: string, prefix: "R" | "P" | "A", index: number): JudgeContractItem {
  const idPattern = new RegExp(`^\\[?(${prefix}-\\d{1,4})\\]?\\s*(?:[:：-]\\s*)?`, "iu");
  const match = text.match(idPattern);
  const id = match?.[1]?.toUpperCase() ?? `${prefix}-${String(index + 1).padStart(3, "0")}`;
  const normalizedText = normalizeWhitespace(match ? text.slice(match[0].length) : text);
  const references = Array.from(normalizedText.matchAll(/\bR-\d{1,4}\b/giu), (reference) => reference[0].toUpperCase());
  return {
    id,
    text: normalizedText,
    references: [...new Set(references)]
  };
}

function tokenPlainText(token: Token): string {
  if (token.type === "checkbox" || token.type === "space" || token.type === "def") {
    return "";
  }
  const nested = tokenTokens(token);
  if (nested.length > 0) {
    return nested.map(tokenPlainText).join(" ");
  }
  if ("text" in token && typeof token.text === "string") {
    return token.text;
  }
  return typeof token.raw === "string" ? token.raw : "";
}

function tokenTokens(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function isListToken(token: Token): token is Tokens.List {
  return token.type === "list" && "items" in token && Array.isArray(token.items);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isMeaningful(value: string): boolean {
  const normalized = normalizeWhitespace(value).replace(/[.。,，;；:：!！?？]+$/gu, "").trim();
  return Boolean(normalized)
    && /[\p{L}\p{N}]/u.test(normalized)
    && !PLACEHOLDER_PATTERN.test(normalized)
    && !ARTIFACT_NAME_PATTERN.test(normalized);
}

function repeatedIds(items: JudgeContractItem[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      duplicates.add(item.id);
    }
    seen.add(item.id);
  }
  return [...duplicates];
}

function issue(
  file: JudgeArtifactName,
  code: JudgeArtifactIssue["code"],
  message: string
): JudgeArtifactIssue {
  return { file, code, message };
}
