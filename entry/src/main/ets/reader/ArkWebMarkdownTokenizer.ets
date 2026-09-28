import { IMarkdownTokenizer, MdToken, mdTokensFromJson } from 'common';

/**
 * IMarkdownTokenizer 的 ArkWeb 桥接实现（设计 §4.3「ArkWeb 内运行 markdown-it」）。
 *
 * 桥接 Schema：Web 上下文内 reader.js 用 markdown-it 解析，只序列化 MdToken 声明的
 * 字段集（slimToken，与 tools 侧 MarkdownItTokenizer 成对维护），经 runJavaScript
 * 回调把 JSON 字符串传回 ArkTS，本类用 mdTokensFromJson 还原后喂给 parseDocument。
 *
 * 同步性说明：ArkWeb 的 runJavaScript 是异步回调，而 IMarkdownTokenizer.parse 是同步
 * 签名 —— 因此本实现是「预取」模型：调用方先 await fetchFromBridge()（ markdown-it
 * 在 Web 内跑完一次解析），随后 parse() 返回缓存的 token 流。fetchFromBridge 已校验
 * payload 结构，parse() 不得在未预取时静默返回空流（那是"解析成功但没内容"的错误形态）。
 */
export class ArkWebMarkdownTokenizer implements IMarkdownTokenizer {
  private tokens: MdToken[] | undefined = undefined;

  /** 在 Web 上下文内执行 markdown-it 解析并缓存 token 流（runJavaScript 回调驱动） */
  fetchFromBridge(payload: string): void {
    this.tokens = mdTokensFromJson(payload);
  }

  parse(_source: string): MdToken[] {
    if (this.tokens === undefined) {
      throw new Error('ArkWebMarkdownTokenizer: parse called before fetchFromBridge');
    }
    return this.tokens;
  }
}
