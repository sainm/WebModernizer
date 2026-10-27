import type { Locale } from './i18n';

/**
 * One-line finding messages, keyed by the `messageKey` the analyzer emits.
 *
 * Only the summary line is translated: it is what every list shows. The long-form
 * risk analysis and the recommendation stay English on purpose — translating 37
 * rule essays into three languages would be a content project, and half-translated
 * technical prose is worse than consistent English.
 *
 * English is intentionally absent: the backend message is already English and is
 * used directly as the fallback.
 */
type Params = Record<string, string | number>;

export const RULE_MESSAGES: Record<Exclude<Locale, 'en'>, Record<string, string>> = {
  zh: {
    'rules.WL-JS-001': '使用了 IE 专有的 attachEvent("{eventName}", ...) 注册事件',
    'rules.WL-JS-002': '使用了 IE 专有的 detachEvent("{eventName}", ...) 解绑事件',
    'rules.WL-JS-003': '读取了 IE 专有的全局 window.event',
    'rules.WL-JS-004': '使用了遗留的 document.all 集合',
    'rules.WL-JS-005': '使用 IE 专有的 createEventObject() 创建事件',
    'rules.WL-JS-006': '使用了 IE 专有的 {objectName}.srcElement',
    'rules.WL-JS-007': '{objectName}.returnValue = {assignedValue}，用于取消默认行为',
    'rules.WL-JS-008': '{objectName}.cancelBubble = {assignedValue}，用于阻止冒泡',
    'rules.WL-JS-009': '调用了已被移除的 showModalDialog',
    'rules.WL-JS-010': '调用了 IE 专有的 showModelessDialog',
    'rules.WL-JS-011': '使用了 IE 专有的 document.selection',
    'rules.WL-JS-012': '使用了 IE 专有的 window.clipboardData',
    'rules.WL-JS-013': '实例化 ActiveX 控件 {progId}',
    'rules.WL-JS-014': '调用了 IE 专有的 execScript 执行字符串代码',
    'rules.WL-JS-015': '使用了 JScript 条件编译指令 {directive}',
    'rules.WL-DOM-001': '调用了 IE 专有的 fireEvent("{eventName}")',
    'rules.WL-BEH-001': '通过 UA 字符串嗅探 IE 版本',
    'rules.WL-HTML-001.assets': '条件注释块中包含脚本或样式资源',
    'rules.WL-HTML-001.plain': '包含 IE 条件注释块',
    'rules.WL-HTML-002': '使用了遗留标签 <{tag}>',
    'rules.WL-HTML-003': '使用了废弃的 language="{value}" 声明',
    'rules.WL-HTML-004': '包含 VBScript 代码块',
    'rules.WL-HTML-005': '嵌入了 ActiveX / OLE 控件（{classid}）',
    'rules.WL-HTML-006': '<{tag}> 上使用了 IE 专有属性 {attribute}',
    'rules.WL-HTML-007': '包含 <xml> 数据岛',
    'rules.WL-HTML-008': '声明了 IE 文档模式（content="{content}"）',
    'rules.WL-HTML-009': '通过 <script for="{target}" event="{event}"> 绑定事件',
    'rules.WL-CSS-001': '在 {property} 中使用了 CSS expression()',
    'rules.WL-CSS-002': '附加了 IE CSS 行为（.htc）',
    'rules.WL-CSS-003.opacity': '使用 IE alpha(opacity) 实现透明',
    'rules.WL-CSS-003.gradient': '使用 IE filter progid:DXImageTransform 渐变',
    'rules.WL-CSS-004.obsolete': '使用了已废弃的厂商属性 {property}',
    'rules.WL-CSS-004.functional': '使用了 {property}，Chromium 仍支持',
    'rules.WL-CSS-005': '使用了 IE CSS hack（{hack}）',
    'rules.WL-CSS-006': '使用了非标准 zoom 属性',
    'rules.WL-DYN-001': '通过字符串拼接生成资源地址',
    'rules.WL-DYN-002': '{api} 在运行时生成标记',
    'rules.WL-DYN-003': '通过 {api} 执行字符串代码',
    'rules.WL-JSP-001': '{container} 中的服务端代码使该代码块只能部分分析',
    'rules.WL-JSP-002': '<{tag} {attribute}> 的目标由服务端代码生成',
  },
  ja: {
    'rules.WL-JS-001': 'IE 専用の attachEvent("{eventName}", ...) でイベントを登録しています',
    'rules.WL-JS-002': 'IE 専用の detachEvent("{eventName}", ...) でイベントを解除しています',
    'rules.WL-JS-003': 'IE 専用のグローバル window.event を参照しています',
    'rules.WL-JS-004': 'レガシーな document.all コレクションを使用しています',
    'rules.WL-JS-005': 'IE 専用の createEventObject() でイベントを生成しています',
    'rules.WL-JS-006': 'IE 専用の {objectName}.srcElement を使用しています',
    'rules.WL-JS-007': '{objectName}.returnValue = {assignedValue} で既定動作を中止しています',
    'rules.WL-JS-008': '{objectName}.cancelBubble = {assignedValue} でバブリングを止めています',
    'rules.WL-JS-009': '廃止された showModalDialog を呼び出しています',
    'rules.WL-JS-010': 'IE 専用の showModelessDialog を呼び出しています',
    'rules.WL-JS-011': 'IE 専用の document.selection を使用しています',
    'rules.WL-JS-012': 'IE 専用の window.clipboardData を使用しています',
    'rules.WL-JS-013': 'ActiveX コントロール {progId} を生成しています',
    'rules.WL-JS-014': 'IE 専用の execScript で文字列コードを実行しています',
    'rules.WL-JS-015': 'JScript 条件コンパイル指令 {directive} を使用しています',
    'rules.WL-DOM-001': 'IE 専用の fireEvent("{eventName}") を呼び出しています',
    'rules.WL-BEH-001': 'User-Agent 文字列で IE を判定しています',
    'rules.WL-HTML-001.assets': '条件付きコメント内でスクリプトまたはスタイルを読み込んでいます',
    'rules.WL-HTML-001.plain': 'IE 条件付きコメントを含んでいます',
    'rules.WL-HTML-002': 'レガシーな要素 <{tag}> を使用しています',
    'rules.WL-HTML-003': '廃止された language="{value}" 宣言を使用しています',
    'rules.WL-HTML-004': 'VBScript のコードブロックを含んでいます',
    'rules.WL-HTML-005': 'ActiveX / OLE コントロールを埋め込んでいます（{classid}）',
    'rules.WL-HTML-006': '<{tag}> に IE 専用属性 {attribute} を使用しています',
    'rules.WL-HTML-007': '<xml> データアイランドを含んでいます',
    'rules.WL-HTML-008': 'IE のドキュメントモードを宣言しています（content="{content}"）',
    'rules.WL-HTML-009': '<script for="{target}" event="{event}"> でイベントを登録しています',
    'rules.WL-CSS-001': '{property} で CSS expression() を使用しています',
    'rules.WL-CSS-002': 'IE の CSS ビヘイビア（.htc）を適用しています',
    'rules.WL-CSS-003.opacity': 'IE の alpha(opacity) で透過を指定しています',
    'rules.WL-CSS-003.gradient': 'IE の filter progid:DXImageTransform でグラデーションを指定しています',
    'rules.WL-CSS-004.obsolete': '廃止されたベンダー接頭辞 {property} を使用しています',
    'rules.WL-CSS-004.functional': '{property} を使用しています（Chromium も解釈します）',
    'rules.WL-CSS-005': 'IE 向け CSS ハック（{hack}）を使用しています',
    'rules.WL-CSS-006': '非標準の zoom プロパティを使用しています',
    'rules.WL-DYN-001': '文字列連結でリソース URL を組み立てています',
    'rules.WL-DYN-002': '{api} が実行時にマークアップを生成しています',
    'rules.WL-DYN-003': '{api} で文字列コードを実行しています',
    'rules.WL-JSP-001': '{container} 内のサーバーサイドコードにより、このブロックは部分的にしか解析できません',
    'rules.WL-JSP-002': '<{tag} {attribute}> の参照先がサーバーサイドで生成されています',
  },
};

/**
 * Replaces {placeholders}. Returns null when a placeholder has no value, so the caller
 * can fall back to the analyzer's English message instead of rendering "{classid}".
 */
export function renderRuleMessage(template: string, params: Params | undefined): string | null {
  let missing = false;
  const rendered = template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === '') {
      missing = true;
      return '';
    }
    return String(value);
  });
  return missing ? null : rendered;
}

export function localizedMessage(
  locale: Locale,
  finding: { message: string; messageKey?: string; messageParams?: Params },
): string {
  if (locale === 'en') return finding.message;
  const key = finding.messageKey;
  if (!key) return finding.message;
  const template = RULE_MESSAGES[locale][key];
  if (!template) return finding.message;
  return renderRuleMessage(template, finding.messageParams) ?? finding.message;
}
