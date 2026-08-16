/**
 * <pre> with a copy-to-clipboard button that appears on hover.
 */
import { useState } from "preact/hooks";

export function CopyPre({ text, class: className }: { text: string; class?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div class="copy-pre">
      <button class="copy-pre-btn" onClick={copy} type="button">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre class={className}>{text}</pre>
    </div>
  );
}
