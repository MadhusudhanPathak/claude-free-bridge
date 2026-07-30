export interface ToolUse {
  tool_name: string;
  parameters: Record<string, string>;
}

export function parseToolUses(text: string): ToolUse[] {
  // Strip fenced code blocks
  const stripped = text.replace(/```(?:[\s\S]*?)```/g, (m) => m.replace(/```/g, ''));
  const re = /<tool_use>\s*<tool_name>([\w_\-]+)<\/tool_name>\s*<parameters>([\s\S]*?)<\/parameters>\s*<\/tool_use>/g;
  const paramRe = /<([\w_\-]+)>([\s\S]*?)<\/\1>/g;
  const matches: ToolUse[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1];
    const paramsBlob = m[2];
    const params: Record<string, string> = {};
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(paramsBlob)) !== null) {
      params[pm[1]] = pm[2].trim();
    }
    matches.push({ tool_name: name, parameters: params });
  }
  return matches;
}
