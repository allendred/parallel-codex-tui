export function detectNativeSessionId(text: string): string | null {
  const labeled = text.match(/\b(?:session id|session_id|session)\s*[:=]\s*([A-Za-z0-9._:@-]{4,})/i);
  if (labeled?.[1] && isLikelyNativeSessionId(labeled[1])) {
    return labeled[1];
  }

  return detectResumeSessionId(text);
}

export function detectResumeSessionId(text: string): string | null {
  const resume = text.match(/\b(?:codex|claude)\s+resume\s+([A-Za-z0-9._:@-]{4,})\b/i);
  return resume?.[1] && isLikelyNativeSessionId(resume[1]) ? resume[1] : null;
}

export function isLikelyNativeSessionId(value: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return true;
  }

  return value.length >= 8 && /[0-9]/.test(value) && /[._:@-]/.test(value);
}
