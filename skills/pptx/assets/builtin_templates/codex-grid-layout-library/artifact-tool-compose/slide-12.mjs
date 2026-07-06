import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide12Tokens = contentTokens["slide-12"];

export function buildSlide12(presentation, tokens = slide12Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-12", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-1",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title], {
        name: "Title-2",
        ...frame({ left: "41px", top: "36px", width: "375px", height: "45px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.body1.agendaItemOne, tokens.body1.agendaItemTwo, tokens.body1.agendaItemThree, tokens.body1.agendaItemFour, tokens.body1.agendaItemFive, tokens.body1.agendaItemSix, tokens.body1.agendaItemSeven, tokens.body1.agendaItemEight, tokens.body1.agendaItemNine, tokens.body1.agendaItemTen], {
        name: "TextBox-8",
        ...frame({ left: "41px", top: "88px", width: "411px", height: "565px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label2.paragraph01, tokens.label2.paragraph02, tokens.label2.paragraph03, tokens.label2.paragraph04, tokens.label2.paragraph05, tokens.label2.paragraph06, tokens.label2.paragraph07, tokens.label2.paragraph08, tokens.label2.paragraph09, tokens.label2.paragraph10], {
        name: "TextBox-9",
        ...frame({ left: "1069px", top: "88px", width: "170px", height: "565px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label1], {
        name: "TextBox-3",
        ...frame({ left: "452px", top: "98px", width: "241px", height: "29px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label3], {
        name: "TextBox-4",
        ...frame({ left: "452px", top: "155px", width: "241px", height: "29px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label4], {
        name: "TextBox-5",
        ...frame({ left: "452px", top: "212px", width: "241px", height: "29px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label5], {
        name: "TextBox-6",
        ...frame({ left: "452px", top: "269px", width: "241px", height: "29px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label6], {
        name: "TextBox-7",
        ...frame({ left: "452px", top: "326px", width: "241px", height: "29px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label7], {
        name: "TextBox-10",
        ...frame({ left: "452px", top: "383px", width: "241px", height: "29px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label8], {
        name: "TextBox-11",
        ...frame({ left: "452px", top: "441px", width: "241px", height: "29px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label9], {
        name: "TextBox-12",
        ...frame({ left: "452px", top: "498px", width: "241px", height: "29px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label10], {
        name: "TextBox-13",
        ...frame({ left: "452px", top: "555px", width: "241px", height: "29px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label11], {
        name: "TextBox-14",
        ...frame({ left: "452px", top: "612px", width: "241px", height: "29px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
