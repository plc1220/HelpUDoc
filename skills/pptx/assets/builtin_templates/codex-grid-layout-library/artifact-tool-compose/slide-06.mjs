import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide06Tokens = contentTokens["slide-06"];

export function buildSlide06(presentation, tokens = slide06Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-06", width: "fill", height: "fill" }, [
      text([tokens.title], {
        name: "TextBox-6",
        ...frame({ left: "41px", top: "49px", width: "640px", height: "126px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextInsetsColorTx1,
      }),
      text([tokens.title4], {
        name: "TextBox-7",
        ...frame({ left: "41px", top: "190px", width: "640px", height: "107px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextInsetsColorTx1,
      }),
      text([tokens.title6], {
        name: "TextBox-8",
        ...frame({ left: "41px", top: "337px", width: "640px", height: "90px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextInsetsColorTx1,
      }),
      text([tokens.title2], {
        name: "TextBox-9",
        ...frame({ left: "649px", top: "69px", width: "420px", height: "57px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextInsetsColorTx1,
      }),
      text([tokens.title3], {
        name: "TextBox-10",
        ...frame({ left: "649px", top: "177px", width: "420px", height: "48px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextInsetsColorTx1,
      }),
      text([tokens.title5], {
        name: "TextBox-11",
        ...frame({ left: "649px", top: "315px", width: "420px", height: "44px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextInsetsColorTx1,
      }),
      text([tokens.title7], {
        name: "TextBox-12",
        ...frame({ left: "649px", top: "417px", width: "420px", height: "39px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextInsetsColorTx1,
      }),
      text([tokens.title9], {
        name: "TextBox-13",
        ...frame({ left: "649px", top: "509px", width: "420px", height: "36px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextInsetsColorTx1,
      }),
      text([tokens.title10], {
        name: "TextBox-14",
        ...frame({ left: "649px", top: "599px", width: "420px", height: "32px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextInsetsColorTx1,
      }),
      text([tokens.title11], {
        name: "TextBox-16",
        ...frame({ left: "649px", top: "655px", width: "420px", height: "27px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextInsetsColorTx1,
      }),
      text([tokens.title8], {
        name: "TextBox-17",
        ...frame({ left: "41px", top: "497px", width: "640px", height: "65px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextInsetsColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
