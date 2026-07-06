import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide14Tokens = contentTokens["slide-14"];

export function buildSlide14(presentation, tokens = slide14Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-14", width: "fill", height: "fill" }, [
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
      text([tokens.title2], {
        name: "Title-2",
        ...frame({ left: "41px", top: "207px", width: "57px", height: "43px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title3], {
        name: "Title-2",
        ...frame({ left: "125px", top: "207px", width: "533px", height: "43px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title4], {
        name: "Title-2",
        ...frame({ left: "41px", top: "285px", width: "57px", height: "43px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title5], {
        name: "Title-2",
        ...frame({ left: "125px", top: "285px", width: "533px", height: "43px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title6], {
        name: "Title-2",
        ...frame({ left: "41px", top: "362px", width: "57px", height: "43px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title7], {
        name: "Title-2",
        ...frame({ left: "125px", top: "362px", width: "533px", height: "43px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title8], {
        name: "Title-2",
        ...frame({ left: "41px", top: "437px", width: "57px", height: "43px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title9], {
        name: "Title-2",
        ...frame({ left: "125px", top: "437px", width: "533px", height: "43px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title10], {
        name: "Title-2",
        ...frame({ left: "41px", top: "514px", width: "57px", height: "43px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title11], {
        name: "Title-2",
        ...frame({ left: "125px", top: "514px", width: "533px", height: "43px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title12], {
        name: "Title-2",
        ...frame({ left: "41px", top: "590px", width: "57px", height: "43px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title13], {
        name: "Title-2",
        ...frame({ left: "125px", top: "590px", width: "533px", height: "43px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
