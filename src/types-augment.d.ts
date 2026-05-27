/**
 * SDK MiddlewareState 类型扩展
 *
 * 通过 TypeScript module augmentation 为 SDK 的 MiddlewareState 添加
 * 中间件填充的 well-known keys 类型声明。
 *
 * 这些字段由 SDK 内置中间件自动填充：
 * - envelope: envelopeFormatter 中间件 → 组装后的 LLM prompt 内容（字符串）
 * - history: historyBuffer 中间件 → 群历史消息列表
 * - quote: quoteRef 中间件 → 引用消息信息
 * - mention: mentionGate 中间件 → @bot 判定结果
 * - command: slashCommand 中间件 → 解析的命令
 */
import '@tencent-connect/qqbot-nodejs';

declare module '@tencent-connect/qqbot-nodejs' {
  interface MiddlewareState {
    /** envelopeFormatter 组装的上下文内容 */
    envelope?: {
      /** 组装后的消息文本（含历史/引用/系统提示） */
      content: string;
      /** 系统提示词 */
      systemPrompt?: string;
      /** 原始消息文本（清洗后） */
      rawContent?: string;
    };
    /** historyBuffer 填充的群历史 */
    history?: Array<{
      role: string;
      content: string;
      senderId?: string;
      senderName?: string;
      timestamp?: number;
    }>;
    /** quoteRef 解析的引用信息 */
    quote?: {
      content: string;
      senderId: string;
      attachments?: unknown[];
      messageId?: string;
    };
    /** mentionGate 判定结果 */
    mention?: {
      wasMentioned: boolean;
      stripped?: string;
    };
    /** slashCommand 解析的命令（命令被匹配时存在） */
    command?: {
      name: string;
      args: string;
    };
  }
}
