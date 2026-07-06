import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide31Tokens = contentTokens["slide-31"];

export function buildSlide31(presentation, tokens = slide31Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-31", width: "fill", height: "fill" }, [
      shape({
        name: "object-3",
        geometry: "rect",
        fill: "#EDEDED",
        ...frame({ left: "623px", top: "0px", width: "657px", height: "720px" }),
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "581px", height: "281px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      text([tokens.title2], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "657px", top: "451px", width: "581px", height: "222px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
