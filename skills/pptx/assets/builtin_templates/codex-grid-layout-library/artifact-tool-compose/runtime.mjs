import { readFileSync } from "node:fs";
import { textStyles } from "./styles.mjs";

export { textStyles };
export const contentTokens = JSON.parse(readFileSync(new URL("./content-tokens.json", import.meta.url), "utf8"));

const px = (value) => typeof value === "string" && value.endsWith("px") ? Number.parseFloat(value) : value;
export function frame(value) {
  return { position: { left: px(value.left), top: px(value.top) }, width: px(value.width), height: px(value.height) };
}
