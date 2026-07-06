import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide07Tokens = contentTokens["slide-07"];

export function buildSlide07(presentation, tokens = slide07Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-07", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-1",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title], {
        name: "Title-2",
        ...frame({ left: "41px", top: "36px", width: "411px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title2.agendaItemOne, tokens.title2.agendaItemTwo, tokens.title2.agendaItemThree, tokens.title2.agendaItemFour, tokens.title2.agendaItemFive, tokens.title2.agendaItemSix], {
        name: "Title-2",
        ...frame({ left: "623px", top: "36px", width: "616px", height: "489px" }),
        style: textStyles.helveticaNeueFont39TopColor000000,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
