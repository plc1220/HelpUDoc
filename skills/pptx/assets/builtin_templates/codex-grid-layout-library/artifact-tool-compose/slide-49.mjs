import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide49Tokens = contentTokens["slide-49"];

export function buildSlide49(presentation, tokens = slide49Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-49", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "375px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      text([tokens.body1], {
        name: "Content-Placeholder-10",
        ...frame({ left: "661px", top: "41px", width: "578px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.label1], {
        name: "Content-Placeholder-10",
        ...frame({ left: "453px", top: "41px", width: "187px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body2], {
        name: "Content-Placeholder-10",
        ...frame({ left: "661px", top: "147px", width: "578px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.label2], {
        name: "Content-Placeholder-10",
        ...frame({ left: "453px", top: "147px", width: "187px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body3], {
        name: "Content-Placeholder-10",
        ...frame({ left: "661px", top: "249px", width: "578px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.label3], {
        name: "Content-Placeholder-10",
        ...frame({ left: "453px", top: "249px", width: "187px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body4], {
        name: "Content-Placeholder-10",
        ...frame({ left: "661px", top: "353px", width: "578px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.label4], {
        name: "Content-Placeholder-10",
        ...frame({ left: "453px", top: "353px", width: "187px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body5], {
        name: "Content-Placeholder-10",
        ...frame({ left: "661px", top: "457px", width: "578px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.label5], {
        name: "Content-Placeholder-10",
        ...frame({ left: "453px", top: "457px", width: "187px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body6], {
        name: "Content-Placeholder-10",
        ...frame({ left: "661px", top: "563px", width: "578px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.label6], {
        name: "Content-Placeholder-10",
        ...frame({ left: "453px", top: "563px", width: "187px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
