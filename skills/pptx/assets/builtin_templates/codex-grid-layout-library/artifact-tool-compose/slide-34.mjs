import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide34Tokens = contentTokens["slide-34"];

export function buildSlide34(presentation, tokens = slide34Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-34", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      table({
        name: "Google-Shape-644-p93",
        rows: 8,
        columns: 5,
        values: [["Column Label","Column Label","Column Label","Column Label","Column Label"],["Data Point","$00.000 / item","Yes","1,000,000k / s","0.00023862381"],["Data Point","$00.000 / item","No","1,000,000k / s","0.00023862381"],["Data Point","$00.000 / item","Yes","1,000,000k / s","0.00023862381"],["Data Point","$00.000 / item","No","1,000,000k / s","0.00023862381"],["Data Point","$00.000 / item","Yes","1,000,000k / s","0.00023862381"],["Data Point","$00.000 / item","No","1,000,000k / s","0.00023862381"],["Data Point","$00.000 / item","Yes","1,000,000k / s","0.00023862381"]],
        columnWidths: [410.09,196.81,196.81,196.81,196.81],
        ...frame({ left: "41px", top: "249px", width: "1197px", height: "367px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
