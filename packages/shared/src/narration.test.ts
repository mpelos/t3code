import { expect, it } from "vite-plus/test";
import { narrationChunks } from "./narration.ts";
import { NARRATION_CHUNK_MAX_BYTES, QWEN_NARRATION_CHUNK_MAX_CHARACTERS } from "@t3tools/contracts";

it("reads prose, link labels, and inline code without narrating code blocks or hidden HTML", () => {
  expect(
    narrationChunks(
      "# Hello\n\nUse **Whisper** and [Google](https://example.com) with `play`.\n\n```ts\nsecret()\n```\n\n<script>hidden</script>\n\n![a diagram](image.png)",
    ),
  ).toEqual(["Hello\n\nUse Whisper and Google with play."]);
});

it.each([
  "a".repeat(2000),
  "a".repeat(2001),
  "Olá mundo. ".repeat(1200),
  "你".repeat(4000),
  "🙂".repeat(3000),
])("keeps every Unicode character within provider character and byte limits", (text) => {
  const chunks = narrationChunks(text);
  expect(chunks.length).toBeGreaterThanOrEqual(Math.ceil(text.length / 2000));
  expect(chunks.join("").replace(/\s/gu, "")).toBe(text.replace(/\s/gu, ""));
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(2000);
    expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(
      NARRATION_CHUNK_MAX_BYTES,
    );
  }
});

it("reads table values without Markdown separators", () => {
  expect(narrationChunks("| Name | Result |\n| --- | --- |\n| Test | Passed |")).toEqual([
    "Name Result\nTest Passed",
  ]);
});

it("bounds local generation segments without losing text or Unicode characters", () => {
  const text = "Olá! Português com acentos e emojis 🙂. ".repeat(100);
  const chunks = narrationChunks(text, "qwen");
  expect(chunks.join("").replace(/\s/gu, "")).toBe(text.replace(/\s/gu, ""));
  expect(chunks.every((chunk) => chunk.length <= QWEN_NARRATION_CHUNK_MAX_CHARACTERS)).toBe(true);
  expect(chunks.length).toBeGreaterThan(narrationChunks(text, "elevenlabs").length);
});
