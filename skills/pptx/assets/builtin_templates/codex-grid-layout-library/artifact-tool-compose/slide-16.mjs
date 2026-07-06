import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide16Tokens = contentTokens["slide-16"];

export function buildSlide16(presentation, tokens = slide16Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-16", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-1",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title], {
        name: "Title-2",
        ...frame({ left: "41px", top: "36px", width: "411px", height: "73px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      table({
        name: "Table-3",
        rows: 6,
        columns: 2,
        values: [["01","Agenda item one"],["02","Agenda item two"],["03","Agenda item three"],["04","Agenda item four"],["05","Agenda item five"],["06","Agenda item six"]],
        columnWidths: [92.23,1105.1],
        ...frame({ left: "41px", top: "177px", width: "1197px", height: "452px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
