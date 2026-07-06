import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide30Tokens = contentTokens["slide-30"];

export function buildSlide30(presentation, tokens = slide30Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-30", width: "fill", height: "fill" }, [
      shape({
        name: "object-3",
        geometry: "rect",
        fill: "#EDEDED",
        ...frame({ left: "623px", top: "174px", width: "562px", height: "546px" }),
      }),
      text([tokens.body1], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "41px", top: "438px", width: "411px", height: "192px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "616px", height: "177px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
