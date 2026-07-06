import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide75Tokens = contentTokens["slide-75"];

export function buildSlide75(presentation, tokens = slide75Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-75", width: "fill", height: "fill" }, [
      shape({
        name: "Rounded-Rectangle-5",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "41px", top: "317px", width: "375px", height: "312px" }),
      }),
      shape({
        name: "Rounded-Rectangle-6",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "453px", top: "317px", width: "375px", height: "312px" }),
      }),
      shape({
        name: "Rounded-Rectangle-7",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "864px", top: "317px", width: "375px", height: "312px" }),
      }),
      text([tokens.body1], {
        name: "Content-Placeholder-9",
        ...frame({ left: "74px", top: "373px", width: "310px", height: "86px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-1",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.body2], {
        name: "Content-Placeholder-10",
        ...frame({ left: "486px", top: "373px", width: "310px", height: "86px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body3], {
        name: "Content-Placeholder-11",
        ...frame({ left: "897px", top: "373px", width: "310px", height: "86px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.title], {
        name: "Title-2",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.stat1], {
        name: "Content-Placeholder-9",
        ...frame({ left: "74px", top: "384px", width: "309px", height: "203px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.stat2], {
        name: "Content-Placeholder-9",
        ...frame({ left: "484px", top: "384px", width: "309px", height: "203px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.stat3], {
        name: "Content-Placeholder-9",
        ...frame({ left: "899px", top: "384px", width: "309px", height: "203px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
