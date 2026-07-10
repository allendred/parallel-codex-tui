export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&larr;/g, "←")
    .replace(/&rarr;/g, "→")
    .replace(/&uarr;/g, "↑")
    .replace(/&darr;/g, "↓")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}
