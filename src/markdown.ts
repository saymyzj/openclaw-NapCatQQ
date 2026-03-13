/**
 * Markdown → 纯文本转换（简化版）
 */

export function markdownToPlain(text: string): string {
  if (!text) return "";
  return text
    // 去除标题标记
    .replace(/^#{1,6}\s+/gm, "")
    // 去除加粗/斜体
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    // 去除删除线
    .replace(/~~(.+?)~~/g, "$1")
    // 去除行内代码
    .replace(/`([^`]+)`/g, "$1")
    // 去除代码块标记（保留内容）
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```/g, ""))
    // 去除链接，保留文本
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // 去除无序列表标记
    .replace(/^[\s]*[-*+]\s+/gm, "• ")
    // 去除有序列表标记
    .replace(/^[\s]*\d+\.\s+/gm, "")
    // 去除分隔线
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .trim();
}

export function collapseDoubleNewlines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}
