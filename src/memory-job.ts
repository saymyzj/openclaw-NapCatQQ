import { join } from 'node:path';
import { homedir } from 'node:os';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { db, markMessagesAsSummarized } from './db.js';
import http from 'http';

export async function runBackgroundSummarizer(api: any, gatewayPort: number, token: string, model: string = "github-copilot/gpt-4o-mini") {
  try {
    // 查出超过 30 条未被总结的消息的群
    const groups = db.prepare('SELECT group_id, COUNT(*) as c FROM messages WHERE is_summarized = 0 GROUP BY group_id HAVING c >= 30').all() as any[];

    for (const row of groups) {
      const groupId = row.group_id;
      const msgs = db.prepare('SELECT id, sender_name, content FROM messages WHERE group_id = ? AND is_summarized = 0 LIMIT 50').all(groupId) as any[];
      
      if (msgs.length === 0) continue;

      const chatText = msgs.map((m: any) => `[${m.sender_name}]: ${m.content}`).join('\n');
      
      const prompt = `概括以下群聊内容，提取出人物、事件、核心信息。以第三人称平铺直叙，尽量简短。群聊记录：\n${chatText}`;
      
      const body = JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      });

      const response = await new Promise<string>((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port: gatewayPort,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "Content-Length": Buffer.byteLength(body),
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      const result = JSON.parse(response);
      const summary = result.choices?.[0]?.message?.content?.trim();

      if (summary) {
        // ★ 写入 OpenClaw 的 Markdown 记忆系统 (确保写入到 chat 工作区) ★
        const workspaceDir = join(homedir(), '.openclaw', 'workspace-chat', 'memory');
        if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true });
        
        const today = new Date().toISOString().split('T')[0];
        const memoryFile = join(workspaceDir, `${today}.md`);
        
        const memoryEntry = `\n\n- [${new Date().toLocaleTimeString()} 群${groupId}潜水记忆]: ${summary}`;
        appendFileSync(memoryFile, memoryEntry, 'utf-8');

        // 标记为已总结
        const ids = msgs.map(m => m.id);
        markMessagesAsSummarized(ids);
        
        api.logger?.info?.(`[NapCat Memory] 成功压缩群 ${groupId} 的记忆并写入 ${today}.md`);
      }
    }
  } catch (err: any) {
    api.logger?.warn?.(`[NapCat Memory] 后台记忆压缩失败: ${err.message}`);
  }
}
