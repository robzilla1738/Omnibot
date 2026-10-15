import createDOMPurify from "dompurify";
import { marked } from "marked";
import { isSafeExternalUrl } from "./omni-bridge";

// A private instance keeps these hooks from affecting any other sanitize call.
const purify = createDOMPurify(window);

purify.addHook("afterSanitizeAttributes", node => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href");
    if (href && isSafeExternalUrl(href)) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    } else {
      node.removeAttribute("href");
    }
  } else if (node.tagName === "IMG" && !/^data:image\//i.test(node.getAttribute("src") ?? "")) {
    // Remote images would let model output make the app request arbitrary URLs, including the local API.
    const placeholder = node.ownerDocument.createElement("span");
    placeholder.className = "omni-blocked-image";
    placeholder.title = "Remote image not loaded";
    placeholder.textContent = node.getAttribute("alt") || "Image not loaded";
    node.replaceWith(placeholder);
  }
});

export function renderMarkdown(text: string): string {
  const cleanText = text
    .replace(/<handoff[\s\S]*?<\/handoff>/gi, "")
    .replace(/<handoff[\s\S]*$/gi, "")
    .trim();
  if (!cleanText) return "";
  return purify.sanitize(marked.parse(cleanText, { async: false }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["form", "input", "button", "style", "iframe", "audio", "video", "source", "picture", "track"],
    FORBID_ATTR: ["style", "srcset", "background", "poster"],
  });
}
