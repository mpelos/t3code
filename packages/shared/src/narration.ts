import { NARRATION_CHUNK_MAX_BYTES } from "@t3tools/contracts";
import type { Nodes } from "mdast";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm);
// ElevenLabs Text to Dialogue recommends at most 2,000 characters per request.
const MAX_CHUNK_CHARACTERS = 2000;

function readableText(node: Nodes): string {
  if (
    node.type === "code" ||
    node.type === "html" ||
    node.type === "definition" ||
    node.type === "image" ||
    node.type === "imageReference"
  )
    return "";
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "break") return "\n";
  if (!("children" in node)) return "";
  const text = node.children.map(readableText).join("");
  if (node.type === "tableCell") return `${text} `;
  if (node.type === "tableRow") return `${text.trim()}\n`;
  return node.type === "paragraph" || node.type === "heading" || node.type === "listItem"
    ? `${text}\n\n`
    : text;
}

export function narrationChunks(markdown: string): ReadonlyArray<string> {
  const text = readableText(parser.parse(markdown))
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const chunks: string[] = [];
  const encoder = new TextEncoder();
  let current = "";
  let bytes = 0;
  for (const word of text.split(/(\s+)/u)) {
    const size = encoder.encode(word).byteLength;
    if (
      bytes + size <= NARRATION_CHUNK_MAX_BYTES &&
      current.length + word.length <= MAX_CHUNK_CHARACTERS
    ) {
      current += word;
      bytes += size;
      continue;
    }
    if (current.trim()) chunks.push(current.trim());
    current = "";
    bytes = 0;
    for (const character of word) {
      const size = encoder.encode(character).byteLength;
      if (
        bytes + size > NARRATION_CHUNK_MAX_BYTES ||
        current.length + character.length > MAX_CHUNK_CHARACTERS
      ) {
        chunks.push(current);
        current = "";
        bytes = 0;
      }
      current += character;
      bytes += size;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
