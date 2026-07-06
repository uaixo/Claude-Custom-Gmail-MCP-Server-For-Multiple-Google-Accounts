// Minimal ambient declaration for html-to-text v10, which ships no type
// definitions and no matching @types package for this major. We use only
// `convert`; this types the subset of options we pass.
declare module "html-to-text" {
  interface HtmlToTextSelector {
    selector: string;
    format?: string;
    options?: Record<string, unknown>;
  }
  interface HtmlToTextLimits {
    /** Max DOM depth walked; deeper content degrades to `ellipsis`. */
    maxDepth?: number;
    maxInputLength?: number;
    ellipsis?: string;
  }
  interface HtmlToTextOptions {
    wordwrap?: number | false | null;
    limits?: HtmlToTextLimits;
    selectors?: HtmlToTextSelector[];
    [key: string]: unknown;
  }
  export function convert(html: string, options?: HtmlToTextOptions): string;
}
