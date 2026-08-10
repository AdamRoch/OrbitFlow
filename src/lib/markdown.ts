import { remark } from "remark";
import remarkHtml from "remark-html";

/**
 * Render markdown to sanitized HTML on the server. This is a localhost
 * single-user tool (no auth, no multi-tenant input), so we trust the input;
 * remark-html escapes raw HTML by default, which is the main XSS vector.
 */
export async function renderMarkdown(md: string | null): Promise<string> {
  if (!md) return "";
  const file = await remark().use(remarkHtml).process(md);
  return String(file);
}
