import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide11Tokens = contentTokens["slide-11"];

export function buildSlide11(presentation, tokens = slide11Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-11", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-1",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title], {
        name: "Title-2",
        ...frame({ left: "41px", top: "36px", width: "787px", height: "45px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.body1.agendaItemOne, tokens.body1.agendaItemTwo, tokens.body1.agendaItemThree, tokens.body1.agendaItemFour, tokens.body1.agendaItemFive, tokens.body1.agendaItemSix, tokens.body1.agendaItemSeven, tokens.body1.agendaItemEight, tokens.body1.agendaItemNine, tokens.body1.agendaItemTen], {
        name: "TextBox-8",
        ...frame({ left: "41px", top: "88px", width: "787px", height: "565px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label1.paragraph01, tokens.label1.paragraph02, tokens.label1.paragraph03, tokens.label1.paragraph04, tokens.label1.paragraph05, tokens.label1.paragraph06, tokens.label1.paragraph07, tokens.label1.paragraph08, tokens.label1.paragraph09, tokens.label1.paragraph10], {
        name: "TextBox-9",
        ...frame({ left: "1033px", top: "88px", width: "206px", height: "565px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
