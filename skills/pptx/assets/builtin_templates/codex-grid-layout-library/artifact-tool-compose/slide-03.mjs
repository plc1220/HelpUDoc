import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide03Tokens = contentTokens["slide-03"];

export function buildSlide03(presentation, tokens = slide03Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-03", width: "fill", height: "fill" }, [
      text([tokens.title3], {
        name: "Title-3",
        ...frame({ left: "41px", top: "390px", width: "992px", height: "262px" }),
        style: textStyles.helveticaNeueFont80BottomColorTx1,
      }),
      text([tokens.title], {
        name: "Subtitle-4",
        ...frame({ left: "41px", top: "41px", width: "376px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.title2], {
        name: "Subtitle-4",
        ...frame({ left: "828px", top: "41px", width: "411px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
