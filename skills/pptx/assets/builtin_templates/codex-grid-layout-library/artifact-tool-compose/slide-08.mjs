import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide08Tokens = contentTokens["slide-08"];

export function buildSlide08(presentation, tokens = slide08Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-08", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-1",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title2], {
        name: "Title-2",
        ...frame({ left: "41px", top: "110px", width: "787px", height: "104px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title], {
        name: "Subtitle-4",
        ...frame({ left: "41px", top: "41px", width: "376px", height: "36px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      table({
        name: "Table-6",
        rows: 5,
        columns: 2,
        values: [["01","Agenda item one"],["02","Agenda item two"],["03","Agenda item three"],["04","Agenda item four"],["05","Agenda item five"]],
        columnWidths: [71.81,509.52],
        ...frame({ left: "41px", top: "317px", width: "581px", height: "312px" }),
      }),
      table({
        name: "Table-7",
        rows: 5,
        columns: 2,
        values: [["06","Agenda item one"],["07","Agenda item two"],["08","Agenda item three"],["09","Agenda item four"],["10","Agenda item five"]],
        columnWidths: [68.83,512.5],
        ...frame({ left: "657px", top: "317px", width: "581px", height: "312px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
